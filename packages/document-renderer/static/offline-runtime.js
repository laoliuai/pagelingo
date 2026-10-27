/* Trusted local runtime. Generated registrations supply escaped data and renderer HTML. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const entries = new Map();
  const scripts = new Map();
  let index;
  let current = 0;
  let mode = 'translation';
  let generation = 0;
  let tocPage = 0;
  let targetBlock;
  const keep = () => new Set(index.chunks.slice(Math.max(0, current - 1), current + 2).map(chunk => chunk.id));
  function paint() {
    if (!index) return;
    const container = byId('content');
    container.replaceChildren();
    for (const info of index.chunks.slice(Math.max(0, current - 1), current + 2)) {
      const data = entries.get(info.id);
      if (!data) continue;
      const section = document.createElement('section');
      section.dataset.chunkId = info.id;
      section.innerHTML = data[mode].html;
      if (data[mode].warnings.length) {
        const notice = document.createElement('p'); notice.className = 'render-warning'; notice.setAttribute('role', 'note');
        notice.textContent = [...new Set(data[mode].warnings)].join('；'); section.prepend(notice);
      }
      container.append(section);
    }
    if (targetBlock) {
      const target = byId(targetBlock);
      if (target) { target.scrollIntoView(); targetBlock = undefined; }
    }
    byId('location').textContent = `${current + 1} / ${index.chunks.length}`;
    byId('previous').disabled = current === 0;
    byId('next').disabled = current >= index.chunks.length - 1;
  }
  function load(position, blockId) {
    if (!index.chunks.length) { paint(); return; }
    current = Math.max(0, Math.min(index.chunks.length - 1, position));
    targetBlock = blockId || index.chunks[current].blockIds[0];
    generation++;
    const wanted = keep();
    for (const [id, script] of scripts) if (!wanted.has(id)) { script.remove(); scripts.delete(id); entries.delete(id); }
    for (const info of index.chunks.slice(Math.max(0, current - 1), current + 2)) {
      if (scripts.has(info.id)) continue;
      const script = document.createElement('script');
      script.src = `data/${info.id}.js`;
      script.dataset.generation = String(generation);
      script.onerror = () => { if (keep().has(info.id)) byId('status').textContent = '本地分片无法加载，请检查阅读包是否完整。'; };
      scripts.set(info.id, script);
      document.body.append(script);
    }
    paint();
  }
  function goBlock(id) {
    const location = index.blockLocations[id];
    if (!location) return;
    const position = index.chunks.findIndex(chunk => chunk.id === location.chunkId);
    load(position, id);
    byId('pdf').src = `../source.pdf#page=${location.pageIndices[0] + 1}`;
  }
  function toc() {
    const nav = byId('toc'); nav.replaceChildren();
    const start = tocPage * 200;
    for (const item of index.toc.slice(start, start + 200)) {
      const link = document.createElement('a'); link.href = `#${item.blockId}`; link.textContent = item.title; link.style.paddingLeft = `${20 + Math.min(item.depth, 8) * 8}px`;
      link.onclick = event => { event.preventDefault(); goBlock(item.blockId); }; nav.append(link);
    }
    for (const [label, direction] of [['前页目录', -1], ['后页目录', 1]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.disabled = direction < 0 ? tocPage === 0 : start + 200 >= index.toc.length;
      button.onclick = () => { tocPage += direction; toc(); }; nav.append(button);
    }
  }
  function setWidth(value) {
    const width = Math.max(30, Math.min(70, value));
    document.documentElement.style.setProperty('--divider', `${width}%`); byId('divider').setAttribute('aria-valuenow', String(Math.round(width)));
  }
  window.PageLingoReader = Object.freeze({
    registerIndex(data) {
      index = data.index;
      byId('title').textContent = data.metadata.title;
      const statuses = { 'not-required': '无需翻译', pending: '待翻译', partial: '部分完成', completed: '已完成', failed: '失败', cancelled: '已取消' };
      byId('status').textContent = `翻译：${statuses[index.translationStatus]} · 解析：${index.parseCoverage === 'full' ? '完整' : '部分页面'}${index.generationKind === 'mock' ? ' · 模拟译文' : ''}${index.warnings.length ? ' · ' + index.warnings.join('；') : ''}`;
      document.body.dataset.view = window.innerWidth < 768 ? 'content' : 'split';
      toc(); load(0);
    },
    registerChunk(data) {
      if (!index || !keep().has(data.chunk.id)) return;
      entries.set(data.chunk.id, data); paint();
    }
  });
  byId('previous').onclick = () => load(current - 1);
  byId('next').onclick = () => load(current + 1);
  byId('mode').onclick = () => { mode = mode === 'translation' ? 'source' : 'translation'; paint(); };
  byId('font').onclick = () => { const root = document.documentElement; root.style.setProperty('--reader-size', root.style.getPropertyValue('--reader-size') === '20px' ? '18px' : '20px'); };
  byId('toc-toggle').onclick = () => { byId('toc').hidden = !byId('toc').hidden; };
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => { document.body.dataset.view = button.dataset.view; }; });
  byId('content').onclick = event => {
    const link = event.target.closest('[data-block-link]');
    if (link) { event.preventDefault(); goBlock(link.dataset.blockLink); return; }
    const block = event.target.closest('[data-block-id]');
    if (block) { const location = index.blockLocations[block.dataset.blockId]; byId('pdf').src = `../source.pdf#page=${location.pageIndices[0] + 1}`; }
  };
  byId('divider').onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const currentWidth = Number(byId('divider').getAttribute('aria-valuenow'));
    setWidth(event.key === 'Home' ? 30 : event.key === 'End' ? 70 : currentWidth + (event.key === 'ArrowLeft' ? -2 : 2));
  };
  byId('divider').onpointerdown = event => { byId('divider').setPointerCapture(event.pointerId); };
  byId('divider').onpointermove = event => { if (byId('divider').hasPointerCapture(event.pointerId)) { const rect = byId('reader').getBoundingClientRect(); setWidth((event.clientX - rect.left) / rect.width * 100); } };
})();
