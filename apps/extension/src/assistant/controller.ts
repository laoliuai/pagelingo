import {
  AssistantEngine,
  PiChatProvider,
  type Conversation,
  type ContextInfo,
  type Quote,
  type UserMessage,
} from '@pagelingo/assistant-core';
import { AssistantHistory, conversationLockName, emptyConversation } from './storage';
import { readSettings } from '../settings/storage';
import { requireApiPermission } from '../settings/connection';
import { errorMessage } from '../shared/types';
import { assistantDeliverySchema, type AssistantDelivery } from '../shared/assistant';

export interface AssistantViewState {
  delivery?: AssistantDelivery;
  conversation?: Conversation;
  draft?: Conversation['draft'];
  history: Conversation[];
  busy: boolean;
  compacting: boolean;
  error: string;
  notice: string;
  context?: ContextInfo;
  runningKey?: string;
}
export class ReadingAssistant {
  readonly store = new AssistantHistory();
  private records = new Map<string, Conversation>();
  private drafts = new Map<string, Conversation['draft']>();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private loadId = 0;
  private abort?: AbortController;
  private disposed = false;
  private liveAnswers = new Map<string, string>();
  private heldKey?: string;
  private state: AssistantViewState = { history: [], busy: false, compacting: false, error: '', notice: '' };
  get snapshot() {
    return this.state;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private update(patch: Partial<AssistantViewState>) {
    if (patch.conversation) {
      patch.conversation = structuredClone(patch.conversation);
      for (const m of patch.conversation.messages)
        if (m.role === 'assistant' && m.status === 'streaming' && this.liveAnswers.has(m.id))
          m.text = this.liveAnswers.get(m.id)!;
    }
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.listeners.forEach((fn) => fn());
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(fn);
    this.queue = run;
    return run;
  }
  private change(key: string, fn: (value: Conversation) => void): Promise<Conversation> {
    return this.exclusive(async () => {
      const operation = async () => {
        const cached = this.records.get(key);
        if (!cached) throw new Error('对话尚未载入。');
        const latest = await this.store.get(key);
        if (!latest && cached.version > 0) throw new Error('对话已在其他窗口删除，请重新载入。');
        const old = latest ?? cached;
        const next = structuredClone(old);
        fn(next);
        const saved = await this.store.save(next, old.version);
        this.records.set(key, saved);
        if (this.state.conversation?.key === key)
          this.update({ conversation: saved, draft: this.drafts.get(key) ?? saved.draft });
        return saved;
      };
      if (this.heldKey === key) return operation();
      return navigator.locks.request(conversationLockName(key), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('这篇文章正在其他窗口生成回答，草稿暂未保存，请等待完成。');
        return operation();
      });
    });
  }
  async refreshHistory() {
    this.update({ history: await this.store.list() });
  }
  async load(raw: AssistantDelivery): Promise<boolean> {
    const id = ++this.loadId;
    const delivery = assistantDeliverySchema.parse(raw);
    const settings = await readSettings();
    this.store.configure(settings.assistant.historyLimit, settings.assistant.historyMaxMiB * 1024 * 1024);
    const loaded = await this.exclusive(async () => {
      const old = await this.store.get(delivery.document.key);
      if (id !== this.loadId || this.disposed) return;
      const value = old ?? emptyConversation(delivery.document);
      this.records.set(value.key, value);
      this.drafts.set(value.key, structuredClone(value.draft));
      this.update({
        delivery,
        conversation: value,
        draft: this.drafts.get(value.key),
        error: '',
        context: undefined,
        notice:
          old && old.revision !== delivery.document.revision
            ? '文章内容已更新；历史引用保留原始文字，本次使用当前文章。'
            : '',
      });
      return value;
    });
    if (!loaded) return false;
    const value = loaded;
    if (delivery.quote) {
      const quote = delivery.quote;
      const seen =
        value.draft.quotes.some((q) => q.id === quote.id) ||
        value.messages.some((m) => m.role === 'user' && m.quotes.some((q) => q.id === quote.id));
      if (!seen) {
        if (value.draft.quotes.length >= 20)
          throw new Error('每次最多添加 20 个引用，请先发送或移除部分引用。');
        await this.setDraft({ quotes: [...value.draft.quotes, quote] });
      }
    }
    await this.refreshHistory();
    return true;
  }
  async setDraft(patch: Partial<Conversation['draft']>): Promise<void> {
    const key = this.state.conversation?.key;
    if (!key) return;
    const next = { ...(this.drafts.get(key) ?? this.state.conversation!.draft), ...patch };
    this.drafts.set(key, next);
    this.update({ draft: next });
    try {
      await this.change(key, (c) => {
        c.draft = structuredClone(this.drafts.get(key)!);
      });
    } catch (e) {
      this.update({ error: errorMessage(e) });
      throw e;
    }
  }
  async showHistory(value: Conversation) {
    await this.exclusive(async () => {
      const record = await this.store.get(value.key);
      if (!record) return;
      this.records.set(record.key, record);
      this.drafts.set(record.key, record.draft);
      const delivery = this.state.delivery?.document.key === record.key ? this.state.delivery : undefined;
      this.update({
        conversation: record,
        draft: record.draft,
        delivery,
        error: '',
        context: undefined,
        notice: delivery ? '' : '历史对话已载入。打开原文并接入文章后可继续提问。',
      });
    });
  }
  async send() {
    const delivery = this.state.delivery;
    const draft = this.state.draft;
    if (!delivery || !draft?.text.trim() || this.state.busy) return;
    const question: UserMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: draft.text,
      quotes: structuredClone(draft.quotes),
      createdAt: Date.now(),
    };
    await this.generate(delivery, question, crypto.randomUUID(), false);
  }
  async retry(id: string) {
    const c = this.state.conversation;
    const delivery = this.state.delivery;
    if (!c || !delivery || this.state.busy) return;
    const last = c.messages.at(-1);
    const question = c.messages.at(-2);
    if (last?.role !== 'assistant' || last.id !== id || question?.role !== 'user')
      throw new Error('只能重试最后一条回答。');
    await this.generate(delivery, question, id, true);
  }
  private async generate(
    delivery: AssistantDelivery,
    question: UserMessage,
    answerId: string,
    retry: boolean,
  ) {
    const key = delivery.document.key;
    this.abort = new AbortController();
    const abort = this.abort;
    this.update({ busy: true, runningKey: key, compacting: false, error: '', notice: '' });
    try {
      await navigator.locks.request(conversationLockName(key), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('这篇文章正在另一个窗口生成回答，请等待完成或在那里停止。');
        this.heldKey = key;
        // A draft rejected while another window held the lock must not poison
        // subsequent sends. Read the latest persisted conversation below.
        await this.queue.catch(() => {});
        abort.signal.throwIfAborted();
        const captured = await chrome.runtime.sendMessage({
          type: 'extension:assistant-context',
          tabId: delivery.tabId,
        });
        if (!captured?.ok) throw new Error(captured?.error ?? '无法更新文章上下文，请重新接入。');
        const freshDelivery = assistantDeliverySchema.parse(captured.value);
        if (freshDelivery.document.key !== key) throw new Error('页面已切换，请先接入当前文章。');
        delivery = freshDelivery;
        if (this.state.delivery?.tabId === delivery.tabId) this.update({ delivery });
        const settings = await readSettings();
        await requireApiPermission(settings);
        const a = settings.assistant;
        this.store.configure(a.historyLimit, a.historyMaxMiB * 1024 * 1024);
        const provider = new PiChatProvider({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: a.model || settings.model,
          temperature: a.temperature,
          stream: a.stream,
          maxTokensParameter: settings.maxTokensParameter,
          disableThinking:
            settings.thinkingMode === 'disabled' ||
            (settings.thinkingMode === 'auto' && new URL(settings.baseUrl).hostname === 'api.deepseek.com'),
        });
        const stored = await this.store.get(key);
        if (stored) this.records.set(key, stored);
        const prior = this.records.get(key)!;
        if (retry && prior.messages.at(-1)?.id !== answerId)
          throw new Error('对话已更新，请载入最新记录后重试。');
        const questionIndex = retry
          ? prior.messages.findIndex((m) => m.id === question.id)
          : prior.messages.length;
        const history = prior.messages.slice(0, questionIndex);
        const summary = prior.summary;
        const mode = this.drafts.get(key)?.mode ?? prior.draft.mode;
        const fresh = {
          id: answerId,
          role: 'assistant' as const,
          text: '',
          status: 'streaming' as const,
          createdAt: Date.now(),
          model: a.model || settings.model,
        };
        await this.change(key, (c) => {
          // Holding the run lock means any pre-existing streaming record belongs
          // to an earlier, interrupted run (for example a closed second panel).
          for (const message of c.messages) {
            if (message.role === 'assistant' && message.status === 'streaming') {
              message.status = 'interrupted';
              message.error = '上次回答已中断，部分内容已保留。';
            }
          }
          if (retry) c.messages[c.messages.length - 1] = fresh;
          else {
            c.messages.push(question, fresh);
            c.draft = { text: '', quotes: [], mode };
            this.drafts.set(key, c.draft);
          }
          c.title = delivery.document.title;
          c.revision = delivery.document.revision;
          c.url = delivery.document.url;
        });
        await this.refreshHistory();
        let text = '';
        let lastSaved = 0;
        let done = false;
        const saveAnswer = async (
          status: 'streaming' | 'completed' | 'interrupted' | 'error',
          error?: string,
        ) => {
          await this.change(key, (c) => {
            const answer = c.messages.find((m) => m.id === answerId);
            if (answer?.role === 'assistant') {
              answer.text = text;
              answer.status = status;
              answer.error = error;
            }
          });
        };
        try {
          for await (const event of new AssistantEngine(provider).run(
            {
              document: delivery.document,
              question,
              history,
              summary,
              mode,
              preferences: a.preferences,
              budget: {
                maxInputTokens: a.maxInputTokens,
                maxOutputTokens: a.maxOutputTokens,
                contextWindowTokens: settings.contextWindowTokens,
              },
              terminology: settings.customGlossary.filter(
                (t) => t.domain === 'all' || t.domain === settings.glossaryDomain,
              ),
            },
            abort.signal,
          )) {
            if (event.type === 'compacting') this.update({ compacting: true });
            else if (event.type === 'summary') {
              await this.change(key, (c) => {
                c.summary = event.summary;
              });
              this.update({ compacting: false });
            } else if (event.type === 'context') {
              await this.change(key, (c) => {
                const answer = c.messages.find((m) => m.id === answerId);
                if (answer?.role === 'assistant') answer.context = event.info;
              });
              if (this.state.conversation?.key === key) this.update({ context: event.info });
            } else if (event.type === 'delta') {
              text += event.text;
              this.liveAnswers.set(answerId, text);
              // Render every delta; persist periodically so refresh can recover a partial answer.
              const current = this.records.get(key)!;
              const visible = structuredClone(current);
              const answer = visible.messages.find((m) => m.id === answerId);
              if (answer?.role === 'assistant') answer.text = text;
              if (this.state.conversation?.key === key) this.update({ conversation: visible });
              if (Date.now() - lastSaved > 300) {
                await saveAnswer('streaming');
                lastSaved = Date.now();
              }
            } else {
              done = true;
              await saveAnswer('completed');
            }
          }
          if (!done) throw new Error('回答未完成，请重试。');
        } catch (e) {
          const error = abort.signal.aborted ? '回答已停止，部分内容已保留。' : errorMessage(e);
          await saveAnswer(abort.signal.aborted ? 'interrupted' : 'error', error);
          if (this.state.conversation?.key === key) this.update({ error: abort.signal.aborted ? '' : error });
        }
      });
    } catch (e) {
      this.update({ error: abort.signal.aborted ? '' : errorMessage(e) });
    } finally {
      this.heldKey = undefined;
      this.liveAnswers.delete(answerId);
      if (this.abort === abort) this.abort = undefined;
      this.update({ busy: false, runningKey: undefined, compacting: false });
      await this.refreshHistory().catch(() => {});
    }
  }
  stop() {
    this.abort?.abort();
  }
  detach() {
    this.update({
      delivery: undefined,
      context: undefined,
      notice: '页面已切换。当前对话仍属于上面的文章，请在新文章右键打开助手或重新接入。',
    });
  }
  async deleteConversation(key: string) {
    await this.queue.catch(() => {});
    await this.store.delete(key);
    this.records.delete(key);
    this.drafts.delete(key);
    if (this.state.conversation?.key === key) {
      const delivery = this.state.delivery;
      if (delivery) await this.load(delivery);
      else this.update({ conversation: undefined, draft: undefined });
    }
    await this.refreshHistory();
  }
  async clearHistory() {
    await this.queue.catch(() => {});
    await this.store.clear();
    this.records.clear();
    this.drafts.clear();
    const delivery = this.state.delivery;
    if (delivery) await this.load(delivery);
    else this.update({ conversation: undefined, draft: undefined });
    await this.refreshHistory();
  }
  async dispose() {
    this.disposed = true;
    this.stop();
    await this.queue.catch(() => {});
    this.listeners.clear();
    await this.store.close();
  }
  async reveal(quote: Quote) {
    const delivery = this.state.delivery;
    if (!delivery || quote.documentKey !== delivery.document.key) throw new Error('请先打开对应文章。');
    if (!quote.blockIds.length) throw new Error('此引用没有可可靠定位的段落，引用文字已保留。');
    const reply = await chrome.runtime.sendMessage({
      type: 'extension:assistant-reveal',
      tabId: delivery.tabId,
      blockId: quote.blockIds[0],
      revision: quote.revision,
    });
    if (!reply?.ok) throw new Error(reply?.error ?? '无法定位原文。');
  }
}
