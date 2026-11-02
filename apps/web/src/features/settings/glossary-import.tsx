import { useState } from 'react';
import {
  glossaryKey,
  mergeGlossaryEntries,
  parseGlossaryFile,
  MAX_GLOSSARY_ENTRIES,
  MAX_GLOSSARY_FILE_BYTES,
  type GlossaryEntry,
} from '@pagelingo/translation-core';
import { Button } from '../../shared/ui/button';
import { Field } from '../../shared/ui/field';
import { Feedback } from '../../shared/ui/toast';

type GlossaryFormat = 'json' | 'csv' | 'tsv';
const maxFileMiB = MAX_GLOSSARY_FILE_BYTES / 1024 / 1024;

function hasIssues(error: unknown): error is { issues: { path: PropertyKey[]; message: string }[] } {
  return Array.isArray((error as { issues?: unknown } | null)?.issues);
}

/** A schema error alone gives no way to find the bad entry in a file of thousands. */
function fileProblem(error: unknown): string {
  if (hasIssues(error) && error.issues[0]) {
    const [index, field] = error.issues[0].path;
    if (typeof index !== 'number') return '词表格式不正确，JSON 需为词条数组。';
    return `第 ${index + 1} 条${typeof field === 'string' ? ` ${field}` : ''}：${error.issues[0].message}`;
  }
  return error instanceof Error ? error.message : '无法读取词表。';
}

/** Rows added but never filled in should not block an import. */
function filledRows(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return entries.filter((entry) => entry.source.trim() || entry.target.trim());
}

export function GlossaryImport({
  entries,
  onImported,
}: {
  entries: readonly GlossaryEntry[];
  onImported: (merged: GlossaryEntry[], summary: string) => void;
}) {
  const [pending, setPending] = useState<{ entries: GlossaryEntry[]; name: string }>();
  const [paste, setPaste] = useState('');
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = new Set(entries.map(glossaryKey));
  const added = pending?.entries.filter((entry) => !keys.has(glossaryKey(entry))).length ?? 0;

  function prepare(text: string, format: GlossaryFormat, name: string) {
    setPending(undefined);
    setProblem('');
    let incoming: GlossaryEntry[];
    try {
      incoming = parseGlossaryFile(text, format);
    } catch (error) {
      setProblem(fileProblem(error));
      return;
    }
    try {
      mergeGlossaryEntries(filledRows(entries), incoming);
      setPending({ entries: incoming, name });
    } catch (error) {
      setProblem(
        hasIssues(error) ? '当前列表里有未填写完整的术语，请先修正或删除后再导入。' : fileProblem(error),
      );
    }
  }
  async function readFile(file: File) {
    setReading(true);
    setPending(undefined);
    setProblem('');
    try {
      if (file.size > MAX_GLOSSARY_FILE_BYTES) throw new Error(`词表文件不能超过 ${maxFileMiB} MiB。`);
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      if (extension !== 'json' && extension !== 'csv' && extension !== 'tsv') {
        throw new Error('请选择 JSON、CSV 或 TSV 词表文件。');
      }
      prepare(await file.text(), extension, file.name);
    } catch (error) {
      setProblem(fileProblem(error));
    } finally {
      setReading(false);
    }
  }
  function previewPaste() {
    const format = /^[\s﻿]*[[{]/.test(paste) ? 'json' : paste.split(/\r?\n/)[0]!.includes('\t') ? 'tsv' : 'csv';
    prepare(paste, format, '粘贴内容');
  }
  function confirm() {
    if (!pending) return;
    try {
      const merged = mergeGlossaryEntries(filledRows(entries), pending.entries);
      setPending(undefined);
      onImported(merged, `已合并：新增 ${added} 条，覆盖 ${pending.entries.length - added} 条。点击“保存术语表”后生效。`);
    } catch (error) {
      setProblem(fileProblem(error));
    }
  }
  return (
    <div className="glossary-import">
      <Field label="导入词表文件">
        <input
          type="file"
          accept=".json,.csv,.tsv"
          disabled={reading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void readFile(file);
          }}
        />
      </Field>
      <p className="muted">
        支持 JSON 数组或有表头的 CSV / TSV，最多 {maxFileMiB} MiB、{MAX_GLOSSARY_ENTRIES.toLocaleString('en-US')}{' '}
        条。相同原词（忽略大小写）与领域以导入的为准，文件中没有的词条继续保留。
      </p>
      {reading && <p role="status">正在读取词表…</p>}
      <details>
        <summary>从表格粘贴批量导入</summary>
        <Field label="批量词条">
          <textarea
            rows={6}
            value={paste}
            placeholder={'source\ttarget\tpolicy\tdomain\nharness\t\tkeep\tmachine-learning'}
            onChange={(event) => setPaste(event.target.value)}
          />
        </Field>
        <p className="muted">
          表头需包含 source、target。policy 和 domain 可省略：有译文默认固定翻译，无译文默认保留原词，领域默认所有领域。
        </p>
        <Button type="button" disabled={!paste.trim()} onClick={previewPaste}>
          预览粘贴词表
        </Button>
      </details>
      {pending && (
        <div className="glossary-preview">
          <p role="status">
            {pending.name}：{pending.entries.length} 个不同词条，新增 {added} 条，覆盖 {pending.entries.length - added} 条。
          </p>
          <div className="form-actions">
            <Button type="button" onClick={() => setPending(undefined)}>
              取消导入
            </Button>
            <Button type="button" onClick={confirm}>
              确认合并词表
            </Button>
          </div>
        </div>
      )}
      <Feedback message={problem} error />
    </div>
  );
}
