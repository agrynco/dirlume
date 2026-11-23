const prefix = "dirlume.kswitcher-address.";

export function kswitcherAddress(peer: string): string {
  return peer ? localStorage.getItem(prefix + peer) ?? "" : "";
}

export function rememberKSwitcherAddress(peer: string, address: string) {
  const host = address.trim();
  if (host) localStorage.setItem(prefix + peer, host);
  else localStorage.removeItem(prefix + peer);
}
