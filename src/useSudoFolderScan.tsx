import { useCallback, useRef, useState } from "react";
import { api, placePath, type Listing, type SshPlace } from "./api";
import { SudoDialog } from "./SudoDialog";

type Request = {
  id: number;
  place: SshPlace;
  signal: AbortSignal;
  resolve: (listing: Listing) => void;
  reject: () => void;
};

export function useSudoFolderScan() {
  const nextId = useRef(0);
  const [queue, setQueue] = useState<Request[]>([]);
  const request = queue[0];

  const authorize = useCallback((place: SshPlace, signal: AbortSignal) => new Promise<Listing>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("The folder scan was canceled."));
      return;
    }
    const id = ++nextId.current;
    const remove = () => setQueue((requests) => requests.filter((request) => request.id !== id));
    const decline = () => {
      signal.removeEventListener("abort", decline);
      remove();
      reject("SSH permission denied.");
    };
    signal.addEventListener("abort", decline, { once: true });
    setQueue((requests) => [...requests, {
      id, place, signal, reject: decline,
      resolve: (listing) => {
        signal.removeEventListener("abort", decline);
        remove();
        resolve(listing);
      },
    }]);
  }), []);

  const prompt = request && <SudoDialog key={request.id} operation="measure" address={request.place.address}
    path={placePath(request.place)} onClose={request.reject} onConfirm={async (password) => {
      const listing = await api.listSsh(request.place.id, request.place.segments, password, undefined, request.signal);
      request.resolve(listing);
    }} />;
  return { authorize, prompt };
}
