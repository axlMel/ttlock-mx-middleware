export const routeKey = (id: number): string => `route:${id}`;
export const deviceRouteKey = (id: number): string => `device-route:${id}`;
export const chainCursorKey = (id: number): string => `chain-cursor:${id}`;
export const catalogKey = (entity: string, id: number): string => `catalog:${entity}:${id}`;

export const routeScanPattern = 'route:*';
export const isRouteKey = (key: string): boolean => /^route:[0-9]+$/.test(key);
