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

/** Lightweight structural signature so unchanged background polls do not trigger full React re-renders. */
function workspaceFingerprint(d: WorkspaceData): string {
  const maxOf = <T,>(arr: T[] | undefined, pick: (x: T) => string | null | undefined) => {
    let best = "";
    for (const item of arr ?? []) {
      const v = pick(item) ?? "";
      if (v > best) best = v;
    }
    return best;
  };
  return [
    d.company?.id ?? "",
    d.company?.updated_at ?? "",
    d.profile?.display_name ?? "",
    d.role ?? "",
    d.threads.length,
    maxOf(d.threads, (t) => `${t.updated_at}:${t.status}:${t.read ? 1 : 0}:${t.pending_sender ? 1 : 0}`),
    d.messages.length,
    maxOf(d.messages, (m) => `${m.id}:${m.delivery_status}:${m.sent_at}`),
    d.drafts.length,
    maxOf(d.drafts, (x) => `${x.updated_at}:${x.text.length}`),
    d.quotes.length,
    maxOf(d.quotes, (q) => `${q.id}:${q.version}`),
    d.customers.length,
    maxOf(d.customers, (c) => c.updated_at),
    d.moments.length,
    maxOf(d.moments, (m) => m.updated_at),
    d.audit.length,
    d.audit[0]?.id ?? "",
    d.channels.length,
    d.documentDeliveries?.length ?? 0,
    d.documentLibrary?.length ?? 0,
  ].join("|");
}

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
      if (!opts?.force && hasDataRef.current && fp === lastFingerprint.current) {
        return next;
      }
      lastFingerprint.current = fp;
      hasDataRef.current = true;
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

  useEffect(() => {
    realStore.connect(mutate, async () => {
      await refresh({ force: true });
    });
    realStore.connectAi({ interpret: interpretRequest, write: writeReply });
    realStore.connectDelivery((id) => send({ data: { id } }));
  }, [realStore, mutate, refresh, send]);

  useEffect(() => {
    let alive = true;
    let generation = 0;
    async function resolve(initialBoot: boolean) {
      const own = ++generation;
      // Avoid blanking the whole screen on background auth refreshes once workspace data is loaded.
      if (initialBoot || !hasDataRef.current) setLoading(true);
      setError("");
      const { data: sessionData, error: authError } = await supabase.auth.getSession();
      if (!alive || generation !== own) return;
      if (!sessionData.session?.user || authError) {
        hasDataRef.current = false;
        lastFingerprint.current = "";
        setSignedIn(false);
        setMode("demo");
        setData(null);
        realStore.clear();
        setLoading(false);
        return;
      }
      setSignedIn(true);
      setMode("real");
      try {
        await refresh({ force: initialBoot });
      } catch {
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

  // Poll while visible: fast (4s) during active AI analysis, calm (20s) when idle, paused when tab is hidden.
  const analysing = useSyncAnalysing(realStore);
  useEffect(() => {
    if (mode !== "real" || !signedIn) return;
    let inFlight = false;
    const poll = () => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState !== "visible"))
        return;
      inFlight = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = setInterval(poll, analysing ? 4000 : 20000);
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
