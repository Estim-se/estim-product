import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useNavigate, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { loadWorkspace, mutateWorkspace, type WorkspaceData } from "@/lib/real.functions";
import { createRealStore } from "@/lib/real-store";
import type { RealMutation } from "@/lib/real.schemas";
import { parseMutation } from "@/lib/real.schemas";
import { WorkspaceContext } from "./workspace-context";
import { interpretRequest, writeReply } from "@/lib/ai-client";
import { sendMessage } from "@/lib/channel.functions";
export { useWorkspace } from "./workspace-context";

/**
 * Exact snapshot signature: an unchanged background poll skips the React update, and any changed field
 * (delivery status, channel number, document name, quote version) still updates the workspace.
 */
function workspaceFingerprint(d: WorkspaceData): string {
  return JSON.stringify(d);
}
/** Time-derived thread state (AI fallback after 90 s, WhatsApp 24 h window) is recomputed at least this often. */
const REHYDRATE_MS = 60_000;
/** Pending draft saves get this long to finish before sign-out continues. */
const SIGN_OUT_FLUSH_MS = 3_000;

/** Isolated child so pathname changes update document.title without re-rendering WorkspaceProvider. */
function CompanyDocumentTitle({ companyName }: { companyName: string | null }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (!companyName) return;
    const previous = document.title;
    document.title = previous.replace(/Volt Vision(?: AB)?/g, companyName);
    const tags = Array.from(
      document.querySelectorAll<HTMLMetaElement>(
        'meta[name="description"],meta[property="og:title"],meta[property="og:description"]',
      ),
    ).filter((tag) => tag.content.includes("Volt Vision"));
    const originals = tags.map((tag) => tag.content);
    tags.forEach((tag) => {
      tag.content = tag.content.replace(/Volt Vision(?: AB)?/g, companyName);
    });
    return () => {
      document.title = previous;
      tags.forEach((tag, i) => {
        tag.content = originals[i] ?? "";
      });
    };
  }, [companyName, pathname]);
  return null;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [realStore] = useState(createRealStore);
  const [mode, setMode] = useState<"demo" | "real">("demo");
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<WorkspaceData | null>(null);
  const identityEpoch = useRef(0);
  const lastFingerprint = useRef("");
  const hasDataRef = useRef(false);
  const lastHydrate = useRef(0);
  const read = useServerFn(loadWorkspace);
  const write = useServerFn(mutateWorkspace);
  const send = useServerFn(sendMessage);
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const refresh = useCallback(
    async (opts?: { force?: boolean }) => {
      const epoch = identityEpoch.current;
      const next = await read();
      if (epoch !== identityEpoch.current) return undefined;
      setError("");
      const fp = workspaceFingerprint(next);
      if (
        !opts?.force &&
        hasDataRef.current &&
        fp === lastFingerprint.current &&
        Date.now() - lastHydrate.current < REHYDRATE_MS
      ) {
        return next;
      }
      lastFingerprint.current = fp;
      hasDataRef.current = true;
      lastHydrate.current = Date.now();
      setData(next);
      realStore.hydrate(next);
      return next;
    },
    [read, realStore],
  );

  const mutate = useCallback(
    async (input: RealMutation) => write({ data: parseMutation(input) }),
    [write],
  );

  // No dependency list: realStore.clear() (sign-out, logged-out start) drops the connection, and the
  // re-render that follows must reconnect it before the next sign-in writes anything.
  useEffect(() => {
    realStore.connect(mutate, async () => {
      await refresh({ force: true });
    });
    realStore.connectAi({ interpret: interpretRequest, write: writeReply });
    realStore.connectDelivery((id) => send({ data: { id } }));
  });

  // Debounced draft edits are saved when the tab is hidden or closed.
  useEffect(() => {
    if (mode !== "real" || !signedIn) return;
    const save = () => void realStore.flush().catch(() => {});
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mode, signedIn, realStore]);

  useEffect(() => {
    let alive = true;
    let generation = 0;
    function signedOutState() {
      hasDataRef.current = false;
      lastFingerprint.current = "";
      setSignedIn(false);
      setMode("demo");
      setData(null);
      realStore.clear();
      setLoading(false);
    }
    async function resolve(initialBoot: boolean) {
      const own = ++generation;
      // Avoid blanking the whole screen on background auth refreshes once workspace data is loaded.
      if (initialBoot || !hasDataRef.current) setLoading(true);
      setError("");
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (!alive || generation !== own) return;
      if (!sessionData.session?.user || authError) {
        signedOutState();
        return;
      }
      setSignedIn(true);
      setMode("real");
      try {
        await refresh({ force: initialBoot });
      } catch {
        // getSession only reads the local session; a revoked one is confirmed with the server.
        const { data: verified, error: verifyError } = await supabase.auth.getUser();
        if (!alive || generation !== own) return;
        // A network failure (AuthRetryableFetchError) keeps the session; a rejected one signs out locally.
        if (!verified.user && verifyError?.name !== "AuthRetryableFetchError") {
          signedOutState();
          void supabase.auth.signOut({ scope: "local" });
          return;
        }
        if (alive) setError("Kunde inte läsa företaget. Försök igen.");
      }
      if (alive && generation === own) setLoading(false);
    }
    void resolve(true);
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      if (event === "SIGNED_OUT") {
        generation++;
        identityEpoch.current++;
        hasDataRef.current = false;
        lastFingerprint.current = "";
        setSignedIn(false);
        setMode("demo");
        setData(null);
        realStore.clear();
        queryClient.clear();
      } else {
        setTimeout(() => void resolve(false), 0);
        void queryClient.invalidateQueries();
      }
      void router.invalidate();
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [realStore, refresh, queryClient, router]);

  // Poll as on main while visible (4 s during AI analysis, 10 s idle). A hidden tab keeps polling every 30 s so
  // unread counts still update, and catches up at once when it becomes visible again.
  const analysing = useSyncAnalysing(realStore);
  useEffect(() => {
    if (mode !== "real" || !signedIn) return;
    let inFlight = false;
    let lastPoll = Date.now();
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      lastPoll = Date.now();
      void refresh({ force: analysing })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(
      () => {
        const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
        if (!hidden || Date.now() - lastPoll >= 30_000) poll();
      },
      analysing ? 4000 : 10000,
    );
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mode, analysing, signedIn, refresh]);

  const signOut = useCallback(async () => {
    await Promise.race([
      realStore.flush().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_FLUSH_MS)),
    ]);
    identityEpoch.current++;
    hasDataRef.current = false;
    lastFingerprint.current = "";
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    realStore.clear();
    setData(null);
    setSignedIn(false);
    setMode("demo");
    await navigate({ to: "/auth", replace: true });
  }, [queryClient, realStore, navigate]);

  const value = useMemo(
    () => ({
      mode,
      setMode,
      signedIn,
      loading,
      error,
      data,
      realStore,
      refresh,
      mutate,
      signOut,
    }),
    [mode, signedIn, loading, error, data, realStore, refresh, mutate, signOut],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      <CompanyDocumentTitle companyName={mode === "real" ? (data?.company?.name ?? null) : null} />
      {children}
    </WorkspaceContext.Provider>
  );
}

function useSyncAnalysing(store: ReturnType<typeof createRealStore>) {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().threads.some((t) => t.status === "analys"),
    () => false,
  );
}
