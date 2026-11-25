export function formatDeviceKey(formattedEui, endpoint) {
  return endpoint === undefined ? formattedEui : `${formattedEui}-${endpoint.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function parseDeviceKey(key) {
  const match = /^((?:[\da-f]{2}-){7}[\da-f]{2})(?:-([\da-f]{2}))?$/i.exec(key);
  if (!match) {
    return undefined;
  }

  const [, eui, endpointByte] = match;
  const endpoint = endpointByte === undefined ? undefined : Number.parseInt(endpointByte, 16);
  if (endpoint !== undefined && (endpoint < 1 || endpoint > 240)) {
    return undefined;
  }

  return { formattedEui: eui.toUpperCase(), endpoint };
}
