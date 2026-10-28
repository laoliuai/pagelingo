const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sourceRoute = new RegExp(`^/api/v1/(?:documents/${uuid}/source|assets/${uuid}/content)$`, 'i');
/** Only owned, same-origin source routes may reach PDF.js. Authorization stays on the server. */
export function isPdfSourceUrl(value: string): boolean {
  return !/\s/.test(value) && sourceRoute.test(value);
}
