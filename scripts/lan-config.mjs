/** Opt-in trusted-LAN demo mode; never wildcard API origins. */
export function lanOrigins(interfaces) {
  return [
    ...new Set(
      Object.values(interfaces)
        .flat()
        .filter(
          (entry) =>
            entry &&
            !entry.internal &&
            entry.family === 'IPv4' &&
            /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
        )
        .map((entry) => `http://${entry.address}:5173`),
    ),
  ];
}
