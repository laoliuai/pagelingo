import { snapshotPreviewIndexSchema, webCaptureManifestSchema, sanitizedSnapshotSchema, type CaptureFile, type CaptureLimits, type SanitizedSnapshot, type SnapshotPreviewIndex, type WebCaptureManifest } from '@pagelingo/document-contracts';
import { sha256 } from './fingerprint.js';
import { semanticProjection, type SemanticUnit } from './semantic.js';
import { attr, byteLength, check, elements, isElement, limitsFor, serialize, utf8, type Element, type Node, type Parent } from './tree.js';
export interface SnapshotPreviewBuild { index: SnapshotPreviewIndex; files: Array<{ descriptor: CaptureFile; html: string }>; warnings: string[] }
/** A resource-resolved manifest with snapshots.previews/nodeLocations empty. */
export type SnapshotPreviewManifestDraft = WebCaptureManifest;
export async function buildSnapshotPreviews(snapshot: SanitizedSnapshot, input: SnapshotPreviewManifestDraft, options?: CaptureLimits): Promise<SnapshotPreviewBuild> {
  snapshot = sanitizedSnapshotSchema.parse(snapshot);
  const limits = limitsFor(options); const draft = webCaptureManifestSchema.parse(input);
  check(!draft.snapshots.previews.length && !Object.keys(draft.snapshots.nodeLocations).length, 'Preview builder requires an empty preview draft');
  const original = draft.files.find(file => file.id === draft.htmlFileId)!;
  check(original.bytes === byteLength(snapshot.html) && original.sha256 === await sha256(utf8(snapshot.html)), 'Preview snapshot digest mismatch');
  const semantic = semanticProjection(snapshot, limits);
  const descriptors = new Map(draft.files.map(file => [file.id, file])); const resources = new Map(draft.resources.map(resource => [resource.id, resource]));
  for (const resource of snapshot.resources) check(resources.get(resource.id)?.url === resource.url, 'Preview resource manifest mismatch');
  const result: SnapshotPreviewBuild = { index: { previews: [], nodeLocations: Object.create(null) as SnapshotPreviewIndex['nodeLocations'] }, files: [], warnings: [] };
  let totalBytes = draft.files.reduce((sum, file) => sum + file.bytes, 0);
  let work = 0;
  const charge = () => check(++work <= limits.maxDomNodes * 512, 'Preview closure work budget exceeded');
  const order = new Map<Node, number>();
  const traverse: Node[] = [...semantic.root.childNodes].reverse();
  while (traverse.length) { charge(); const node = traverse.pop()!; order.set(node, order.size); if (isElement(node)) traverse.push(...[...node.childNodes].reverse()); }
  const bySourceId = new Map(elements(semantic.root).map(node => [attr(node, 'data-pl-node'), node]));
  const contextUnits = new Map<Node, SemanticUnit[]>();
  for (const unit of semantic.units) {
    let ancestor: Node | null = unit.element;
    while (ancestor && isElement(ancestor)) {
      charge();
      if (['th', 'thead', 'caption'].includes(ancestor.tagName)) {
        const entries = contextUnits.get(ancestor) ?? []; entries.push(unit); contextUnits.set(ancestor, entries);
      }
      ancestor = ancestor.parentNode;
    }
  }
  // Context membership is fixed for the snapshot. Parse references and examine
  // table children only once, even when many units inherit the same headers.
  const targetsByNode = new Map<Node, Node[]>();
  const targetsFor = (node: Element): Node[] => {
    const cached = targetsByNode.get(node);
    if (cached) return cached;
    const targets: Node[] = [];
    const references = attr(node, 'data-pl-headers');
    if (references) for (const id of references.split(/\s+/)) {
      charge();
      const target = bySourceId.get(id);
      if (target) targets.push(target);
    }
    if (node.tagName === 'table') for (const child of node.childNodes) {
      charge();
      if (isElement(child) && ['thead', 'caption'].includes(child.tagName)) targets.push(child);
    }
    targetsByNode.set(node, targets);
    return targets;
  };
  const render = (units: SemanticUnit[]) => {
    const keep = new Set<Node>(); const full = new Set<Node>(); const retained = new Map<Node, Set<Node>>();
    const closure = new Set(units);
    if (closure.size > limits.maxPreviewBlocks) return null;
    const pending = [...units];
    const expandedTargets = new Set<Node>();
    while (pending.length) {
      const unit = pending.pop()!;
      let ancestor: Node | null = unit.element;
      while (ancestor && isElement(ancestor)) {
        charge();
        for (const target of targetsFor(ancestor)) {
          charge();
          if (expandedTargets.has(target)) continue;
          expandedTargets.add(target);
          const context = contextUnits.get(target) ?? [];
          // This entire group is required. Its size alone can make the unit
          // impossible, so do not enumerate or render that oversized closure.
          if (context.length > limits.maxPreviewBlocks) return null;
          for (const extra of context) {
            charge();
            if (closure.has(extra)) continue;
            closure.add(extra);
            if (closure.size > limits.maxPreviewBlocks) return null;
            pending.push(extra);
          }
        }
        ancestor = ancestor.parentNode;
      }
    }
    const expanded = [...closure].sort((a, b) => a.id.localeCompare(b.id));
    for (const unit of expanded) {
      for (const part of unit.content) {
        full.add(part); let ancestor: Node | null = part;
        while (ancestor) {
          charge(); keep.add(ancestor);
          const parent: Parent | null = 'parentNode' in ancestor ? ancestor.parentNode : null;
          if (parent) { let children = retained.get(parent); if (!children) { children = new Set(); retained.set(parent, children); } children.add(ancestor); }
          ancestor = parent;
        }
      }
      keep.add(unit.element);
    }
    const nodeIds: string[] = []; const fileIds = new Set<string>();
    const retainedChildren = (node: Node): Node[] => [...(retained.get(node) ?? [])].sort((a, b) => order.get(a)! - order.get(b)!);
    const clone = (node: Node, whole = false): Node | null => {
      charge();
      if (!whole && !keep.has(node)) return null;
      const include = whole || full.has(node);
      if (!isElement(node)) return { ...node };
      const id = attr(node, 'data-pl-node'); if (id) nodeIds.push(id);
      const resourceId = attr(node, 'data-pl-resource');
      if (resourceId) {
        const resource = resources.get(resourceId); check(resource, 'Unregistered preview resource');
        if (resource.status === 'available') { const file = descriptors.get(resource.fileId); check(file?.role === 'image', 'Preview resource must be an image'); fileIds.add(file.id); }
      }
      const copied = { ...node, attrs: node.attrs.map(a => ({ ...a })), parentNode: null, childNodes: [] } as typeof node;
      copied.childNodes = (include ? node.childNodes : retainedChildren(node)).flatMap(child => { const value = clone(child, include); return value && 'parentNode' in value ? [{ ...value, parentNode: copied }] : []; });
      return copied;
    };
    const fragment = { ...semantic.root, childNodes: retainedChildren(semantic.root).flatMap(node => { const value = clone(node); return value && 'parentNode' in value ? [value] : []; }) } as Parent;
    const html = serialize(fragment); const resourceFileIds = [...fileIds];
    return { html, blockIds: expanded.map(unit => unit.id), htmlBytes: byteLength(html), nodeIds, resourceFileIds, resourceBytes: resourceFileIds.reduce((sum, id) => sum + descriptors.get(id)!.bytes, 0) };
  };
  type Rendered = NonNullable<ReturnType<typeof render>>;
  const fits = (value: ReturnType<typeof render>): value is Rendered => value !== null && value.htmlBytes <= limits.maxPreviewHtmlBytes && value.resourceBytes <= limits.maxPreviewResourceBytes;
  const emit = async (units: SemanticUnit[], rendered: Rendered) => {
    if (!units.length) return;
    if (draft.files.length + result.files.length >= limits.maxFiles || totalBytes + rendered.htmlBytes > limits.maxTotalBytes) { result.warnings.push(`Preview budget exceeded for ${units.map(unit => unit.id).join(', ')}; original download remains available`); return; }
    const id = `preview_${result.files.length + 1}`; const fileId = `${id}_html`; const path = `previews/${id}.html`;
    check(!descriptors.has(fileId) && !draft.files.some(file => file.path === path), 'Preview file ID/path collision');
    const descriptor: CaptureFile = { id: fileId, path, role: 'preview', mediaType: 'text/html', bytes: rendered.htmlBytes, sha256: await sha256(utf8(rendered.html)) };
    result.files.push({ descriptor, html: rendered.html }); totalBytes += rendered.htmlBytes;
    result.index.previews.push({ id, fileId, nodeIds: rendered.nodeIds, blockIds: rendered.blockIds, resourceFileIds: rendered.resourceFileIds, htmlBytes: rendered.htmlBytes, resourceBytes: rendered.resourceBytes });
    for (const nodeId of rendered.nodeIds) if (!Object.hasOwn(result.index.nodeLocations, nodeId)) result.index.nodeLocations[nodeId] = { previewId: id, anchorId: `pl_${nodeId}` };
  };
  let batch: SemanticUnit[] = []; let rendered = render([])!;
  for (const unit of semantic.units) {
    const candidate = batch.length < limits.maxPreviewBlocks ? render([...batch, unit]) : null;
    if (candidate && fits(candidate)) { batch.push(unit); rendered = candidate; continue; }
    const single = batch.length === 0 ? candidate : render([unit]);
    await emit(batch, rendered); batch = []; rendered = render([])!;
    if (!fits(single)) result.warnings.push(`Oversized preview unit ${unit.id}; original download remains available`);
    else { batch = [unit]; rendered = single; }
  }
  await emit(batch, rendered); snapshotPreviewIndexSchema.parse(result.index); return result;
}
export function resolveSnapshotAnchor(index: SnapshotPreviewIndex, nodeId: string): { previewId: string; anchorId: string } | null {
  return Object.hasOwn(index.nodeLocations, nodeId) ? index.nodeLocations[nodeId] : null;
}
