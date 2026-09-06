import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import App from "./App";
import { bindApplicationScope, type ApplicationScope } from "./application-scope";
import { AUTH_REQUIRED_EVENT, ApplicationAccessUnavailable, applicationAccessRetryDelay, beginGoogleLogin, readApplicationAccess, rememberApplicationRecoveryScope, signOutApplication, takeApplicationRecoveryScope, type ApplicationAccess } from "./application-auth";
import "./application-auth.css";

type GateState = "checking" | "ready" | "required" | "reconnecting" | "error" | "signing-in" | "signing-out" | "sign-out-error";
type LockReason = "auth" | "transient" | "invalid" | "owner" | "channel" | "signout";

export default function ApplicationGate() {
  const [access, setAccess] = useState<ApplicationAccess | null>(null);
  const [state, setState] = useState<GateState>("checking");
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const current = useRef<ApplicationAccess | null>(null);
  const binding = useRef<ApplicationScope | null>(null);
  const announced = useRef(false);
  const lockReason = useRef<LockReason | null>(null);
  const recovery = useRef<{ startedAt: number; attempt: number; nextAt: number } | null>(null);
  const recoveryScope = useRef<string | null | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const lock = useCallback((detail = "Your session ended. Sign in again.", reason: LockReason = "auth") => {
    cancelRetry();
    lockReason.current = reason;
    if (reason !== "transient") recovery.current = null;
    sequence.current++;
    request.current?.abort();
    binding.current?.lock();
    document.title = "Sign in - Superlocal";
    // Remove messages/iframes before any fresh identity check or navigation.
    flushSync(() => {
      setAccess(null);
      setState("required");
      setMessage(detail);
    });
  }, [cancelRetry]);

  const refresh = useCallback(async function refresh(initial = false): Promise<void> {
    // An old focus callback or transport failure must not undo explicit logout.
    if (lockReason.current === "signout" || lockReason.current === "channel" || lockReason.current === "owner") return;
    cancelRetry();
    const version = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (initial) {
      recovery.current = null;
      if (recoveryScope.current === undefined) recoveryScope.current = takeApplicationRecoveryScope();
      setState("checking");
    }
    try {
      const next = await readApplicationAccess(controller.signal);
      if (controller.signal.aborted || version !== sequence.current) return;
      const ready = next.method === "loopback" || next.authenticated;
      if (!ready) {
        current.current = next;
        recovery.current = null;
        if (binding.current) lock();
        else { lockReason.current = "auth"; setAccess(null); setState("required"); }
        return;
      }
      const scope = next.method === "google" ? next.scope : null;
      const changedDuringReload = recoveryScope.current !== undefined && recoveryScope.current !== null && recoveryScope.current !== scope;
      recoveryScope.current = null;
      if (changedDuringReload && (location.pathname !== "/" || location.search || location.hash)) {
        lock("Your account changed. Opening your inbox…", "owner");
        location.replace("/");
        return;
      }
      if (binding.current && (binding.current.signal.aborted || binding.current.scope !== scope)) {
        if (scope !== null && binding.current.scope === scope && (lockReason.current === "transient" || lockReason.current === "auth")) {
          // Never revive the aborted runtime. A restrict-only handoff checks the
          // identity again after reload before retaining this thread/draft URL.
          const preserveRoute = rememberApplicationRecoveryScope(scope);
          if (controller.signal.aborted || version !== sequence.current) return;
          recovery.current = null;
          if (preserveRoute) location.reload();
          else location.replace("/");
          return;
        }
        lock("Your account changed. Opening your inbox…", "owner");
        // Cookies are shared across tabs; JS closures are not. Never mount B in
        // A's runtime, and discard A's thread/draft route on the way out.
        location.replace("/");
        return;
      }
      binding.current = bindApplicationScope(scope);
      lockReason.current = null;
      recovery.current = null;
      current.current = next;
      setAccess(previous => previous?.method === "google" && next.method === "google" && previous.authenticated && next.authenticated
        && previous.scope === next.scope && previous.user.name === next.user.name && previous.user.email === next.user.email ? previous : next);
      setState("ready");
      if (next.method === "google" && !announced.current) {
        announced.current = true;
        channel.current?.postMessage({ type: "signed-in", scope: next.scope });
      }
    } catch (error) {
      if (controller.signal.aborted || version !== sequence.current) return;
      // Temporary downtime hides private UI too, but does not claim logout or
      // discard a still-valid Google cookie. Only transient failures retry.
      if (error instanceof ApplicationAccessUnavailable && (lockReason.current === null || lockReason.current === "transient")) {
        const attempt = recovery.current ?? { startedAt: Date.now(), attempt: 0, nextAt: 0 };
        lock("", "transient");
        recovery.current = attempt;
        const delay = applicationAccessRetryDelay(attempt.attempt, attempt.startedAt, Date.now(), error.retryAfterMs);
        if (delay !== null) {
          attempt.attempt++;
          attempt.nextAt = Date.now() + delay;
          setState("reconnecting");
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (recovery.current !== attempt || lockReason.current !== "transient") return;
            if (Date.now() >= attempt.startedAt + 120_000) { setState("error"); return; }
            if (document.visibilityState === "visible") void refresh();
          }, delay);
        } else setState("error");
      } else {
        lock("", error instanceof ApplicationAccessUnavailable ? lockReason.current ?? "invalid" : "invalid");
        setState("error");
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [cancelRetry, lock]);

  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get("auth") === "denied") {
      setMessage("Sign-in wasn’t completed. Use an approved Google account.");
      url.searchParams.delete("auth");
      url.searchParams.delete("error");
      url.searchParams.delete("error_description");
      history.replaceState(null, "", url);
    }
    void refresh(true);
    const required = () => {
      if (current.current?.method !== "google" || lockReason.current === "signout" || lockReason.current === "channel" || lockReason.current === "owner") return;
      lock();
      void refresh();
    };
    addEventListener(AUTH_REQUIRED_EVENT, required);
    try {
      channel.current = new BroadcastChannel("superlocal:application-auth");
      channel.current.onmessage = event => {
        if (current.current?.method !== "google" || lockReason.current === "signout") return;
        if (event.data === "signed-out") lock(undefined, "channel");
        else if (event.data?.type === "signed-in" && (binding.current?.signal.aborted || binding.current?.scope !== event.data.scope)) {
          lock();
          void refresh();
        }
      };
    } catch { /* Server-side session checks remain authoritative. */ }
    return () => {
      sequence.current++;
      request.current?.abort();
      cancelRetry();
      recovery.current = null;
      removeEventListener(AUTH_REQUIRED_EVENT, required);
      channel.current?.close();
      channel.current = null;
    };
  }, [cancelRetry, lock, refresh]);

  useEffect(() => {
    if ((state !== "ready" || access?.method !== "google") && state !== "reconnecting") return;
    const visible = () => {
      if (document.visibilityState !== "visible" || request.current) return;
      if (state === "reconnecting") {
        const attempt = recovery.current;
        if (!attempt || lockReason.current !== "transient") return;
        if (Date.now() >= attempt.startedAt + 120_000) { cancelRetry(); setState("error"); return; }
        // Focus resumes a due check; it never bypasses backoff or Retry-After.
        if (Date.now() < attempt.nextAt) return;
      }
      void refresh();
    };
    const timer = state === "ready" ? setInterval(visible, 15_000) : null;
    addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { if (timer !== null) clearInterval(timer); removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [state, access?.method, cancelRetry, refresh]);

  useEffect(() => {
    if (state === "ready") return;
    document.title = state === "reconnecting" ? "Reconnecting - Superlocal" : "Sign in - Superlocal";
    // An unauthenticated document must not inspect legacy private preferences.
    document.documentElement.dataset.theme ||= "dark";
    document.documentElement.dataset.style ||= "Superlocal";
  }, [state]);

  async function signIn() {
    cancelRetry();
    recovery.current = null;
    lockReason.current = null;
    const version = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState("signing-in");
    setMessage("");
    try {
      const url = await beginGoogleLogin(controller.signal);
      if (!controller.signal.aborted && version === sequence.current) location.assign(url);
    } catch {
      if (controller.signal.aborted || version !== sequence.current) return;
      setState("required");
      setMessage("Couldn’t start Google sign-in. Please try again.");
    }
  }

  async function signOut() {
    lock("", "signout");
    setState("signing-out");
    channel.current?.postMessage("signed-out");
    const version = ++sequence.current;
    const controller = new AbortController();
    request.current = controller;
    try {
      await signOutApplication(controller.signal);
      if (controller.signal.aborted || version !== sequence.current) return;
      setState("required");
      setMessage("");
    } catch {
      if (controller.signal.aborted || version !== sequence.current) return;
      setState("sign-out-error");
      setMessage("Couldn’t sign out. Retry to end your server session.");
    }
  }

  if (state === "ready" && access) {
    return <App applicationUser={access.method === "google" ? access.user ?? undefined : undefined} onSignOut={access.method === "google" ? () => { void signOut(); } : undefined} />;
  }
  if (state === "checking") return <div className="application-auth-loading" aria-label="Checking access" />;

  const reconnecting = state === "reconnecting";
  const checkingFailed = state === "error" || reconnecting;
  const signingOut = state === "signing-out" || state === "sign-out-error";
  const busy = state === "signing-in" || state === "signing-out";
  return (
    <main className="application-auth" aria-busy={busy || reconnecting}>
      <div className="application-auth-content">
        <h1>{reconnecting ? "Reconnecting to Superlocal" : checkingFailed ? "Couldn’t check access" : signingOut ? "Sign out of Superlocal" : "Sign in to Superlocal"}</h1>
        <p>{reconnecting ? "The server is temporarily unavailable. Retrying your session check." : checkingFailed ? "The server couldn’t confirm your session. Try again." : signingOut ? "Your inbox is hidden while your session ends." : "Use an approved Google account."}</p>
        <button className="application-auth-button" type="button" disabled={busy} onClick={() => { if (checkingFailed) void refresh(true); else if (signingOut) void signOut(); else void signIn(); }}>
          {reconnecting ? "Retry now" : checkingFailed ? "Retry" : signingOut ? busy ? "Signing out…" : "Retry sign out" : busy ? "Opening Google…" : "Continue with Google"}
        </button>
        {message && <p className="application-auth-message" role="alert">{message}</p>}
      </div>
    </main>
  );
}
