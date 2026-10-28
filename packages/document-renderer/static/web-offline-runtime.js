/* Trusted classic script: works with ordinary file:// security, without fetch or ESM. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const content = byId('content'), status = byId('status');
  let index, locations = new Map(), active = 0, mode = 'source', request = 0, current;
  const cache = new Map();
  const closePreview = () => { byId('preview-frame').replaceChildren(); byId('preview').hidden = true; content.hidden = false; };
  const failedImage = image => {
    if (image.dataset.failed) return;
    image.dataset.failed = 'true';
    const warning = document.createElement('span'); warning.className = 'reader-warning';
    const record = current?.images.find(item => image.getAttribute('src') === item.url);
    warning.textContent = `图片无法读取或解码：${record?.id ?? image.alt}`;
    image.replaceWith(warning);
  };
  function render(payload) {
    current = payload; closePreview();
    const section = document.createElement('article'); section.dataset.webChunk = payload.id;
    // Only generated, binding-checked renderer markup can reach this sink.
    section.innerHTML = payload.modes[mode]; content.replaceChildren(section);
    for (const image of section.querySelectorAll('img')) {
      image.addEventListener('error', () => failedImage(image), { once: true });
      if (image.complete && !image.naturalWidth) failedImage(image);
    }
    for (const block of section.querySelectorAll('[data-block-id]')) {
      const button = document.createElement('button'); button.className = 'locate'; button.textContent = '定位快照';
      button.addEventListener('click', () => {
        closePreview(); content.hidden = true; byId('preview').hidden = false;
        const location = locations.get(block.dataset.sourceNode);
        if (!location?.path) { byId('preview-status').textContent = '该源节点的归档快照不可用；请返回原文阅读，或查看 source 目录中的原始附件。'; return; }
        byId('preview-status').textContent = '归档快照 · 已清洗；原始脚本、样式、表单和外部链接不执行。';
        const frame = document.createElement('iframe'); frame.title = '归档快照'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer';
        frame.src = `${location.path}#${encodeURIComponent(location.anchorId)}`;
        byId('preview-frame').replaceChildren(frame);
      }); block.append(button);
    }
    byId('location').textContent = `${active + 1} / ${index.chunks.length}`;
    byId('chunk-number').value = String(active + 1); byId('chunk-number').max = String(index.chunks.length);
    byId('previous').disabled = active === 0; byId('next').disabled = active === index.chunks.length - 1;
    status.textContent = `离线阅读 · ${index.translationStatus} · ${index.generationKind}`;
  }
  function navigate(position, blockId) {
    if (!index || !Number.isInteger(position) || position < 0 || position >= index.chunks.length) return;
    active = position; const id = index.chunks[position].id, token = ++request;
    const finish = payload => { if (token !== request) return; render(payload); if (blockId) document.getElementById(blockId)?.scrollIntoView(); };
    if (cache.has(id)) { finish(cache.get(id)); return; }
    closePreview(); current = undefined; content.replaceChildren(); status.textContent = '正在读取本地分片…';
    const script = document.createElement('script'); script.src = `data/${id}.js`;
    const timer = setTimeout(() => { script.remove(); if (token === request) status.textContent = '本地分片读取超时，请重新校验离线包。'; }, 10000);
    script.onload = () => { clearTimeout(timer); script.remove(); const payload = cache.get(id); if (payload) finish(payload); else if (token === request) status.textContent = '本地分片无有效数据，请重新校验离线包。'; };
    script.onerror = () => { clearTimeout(timer); script.remove(); if (token === request) status.textContent = '本地分片缺失或无法读取，请重新校验离线包。'; };
    document.head.append(script);
  }
  window.PageLingoWebReader = Object.freeze({
    registerIndex(value) {
      if (index) return;
      index = value.index; locations = new Map(value.locations.map(location => [location.nodeId, location]));
      for (const entry of index.toc) {
        const button = document.createElement('button'); button.textContent = entry.title;
        button.addEventListener('click', () => navigate(index.chunks.findIndex(c => c.id === index.blockLocations[entry.blockId]?.chunkId), entry.blockId)); byId('toc').append(button);
      }
      if (index.chunks.length) navigate(0); else status.textContent = '该来源没有可阅读正文。';
    },
    registerChunk(payload) {
      if (!index?.chunks.some(chunk => chunk.id === payload.id)) return;
      cache.set(payload.id, payload);
      while (cache.size > 3) cache.delete(cache.keys().next().value);
    },
  });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; if (current) render(current); }));
  byId('previous').onclick = () => navigate(active - 1); byId('next').onclick = () => navigate(active + 1);
  byId('go').onclick = () => navigate(Number(byId('chunk-number').value) - 1); byId('close-preview').onclick = closePreview;
  byId('theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; };
  content.addEventListener('click', event => {
    const anchor = event.target.closest('a'); if (!anchor) return;
    if (anchor.dataset.blockLink) { event.preventDefault(); const id = anchor.dataset.blockLink; navigate(index.chunks.findIndex(c => c.id === index.blockLocations[id]?.chunkId), id); }
    else { event.preventDefault(); status.textContent = '离线阅读器不打开外部链接。原始地址：' + anchor.getAttribute('href'); }
  });
})();
