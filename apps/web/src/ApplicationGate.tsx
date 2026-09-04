import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import App from "./App";
import { bindApplicationScope, type ApplicationScope } from "./application-scope";
import { AUTH_REQUIRED_EVENT, beginGoogleLogin, readApplicationAccess, signOutApplication, type ApplicationAccess } from "./application-auth";
import "./application-auth.css";

type GateState = "checking" | "ready" | "required" | "error" | "signing-in" | "signing-out" | "sign-out-error";

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

  const lock = useCallback((detail = "Your session ended. Sign in again.") => {
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
  }, []);

  const refresh = useCallback(async (initial = false) => {
    const version = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (initial) setState("checking");
    try {
      const next = await readApplicationAccess(controller.signal);
      if (controller.signal.aborted || version !== sequence.current) return;
      const ready = next.method === "loopback" || next.authenticated;
      if (!ready) {
        current.current = next;
        if (binding.current) lock();
        else { setAccess(null); setState("required"); }
        return;
      }
      const scope = next.method === "google" ? next.scope : null;
      if (binding.current && (binding.current.signal.aborted || binding.current.scope !== scope)) {
        lock("Your account changed. Opening your inbox…");
        // Cookies are shared across tabs; JS closures are not. Never mount B in
        // A's runtime, and discard A's thread/draft route on the way out.
        location.replace("/");
        return;
      }
      binding.current = bindApplicationScope(scope);
      current.current = next;
      setAccess(previous => previous?.method === "google" && next.method === "google" && previous.authenticated && next.authenticated
        && previous.scope === next.scope && previous.user.name === next.user.name && previous.user.email === next.user.email ? previous : next);
      setState("ready");
      if (next.method === "google" && !announced.current) {
        announced.current = true;
        channel.current?.postMessage({ type: "signed-in", scope: next.scope });
      }
    } catch {
      if (controller.signal.aborted || version !== sequence.current) return;
      // Never leave private UI visible when the current session cannot be checked.
      lock("");
      setState("error");
    }
  }, [lock]);

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
      if (current.current?.method !== "google") return;
      lock();
      void refresh();
    };
    addEventListener(AUTH_REQUIRED_EVENT, required);
    try {
      channel.current = new BroadcastChannel("superlocal:application-auth");
      channel.current.onmessage = event => {
        if (current.current?.method !== "google") return;
        if (event.data === "signed-out") lock();
        else if (event.data?.type === "signed-in" && (binding.current?.signal.aborted || binding.current?.scope !== event.data.scope)) {
          lock();
          void refresh();
        }
      };
    } catch { /* Server-side session checks remain authoritative. */ }
    return () => {
      sequence.current++;
      request.current?.abort();
      removeEventListener(AUTH_REQUIRED_EVENT, required);
      channel.current?.close();
      channel.current = null;
    };
  }, [lock, refresh]);

  useEffect(() => {
    if (state !== "ready" || access?.method !== "google") return;
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(visible, 15_000);
    addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [state, access?.method, refresh]);

  useEffect(() => {
    if (state === "ready") return;
    document.title = "Sign in - Superlocal";
    // An unauthenticated document must not inspect legacy private preferences.
    document.documentElement.dataset.theme ||= "dark";
    document.documentElement.dataset.style ||= "Superlocal";
  }, [state]);

  async function signIn() {
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
    lock("");
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

  const checkingFailed = state === "error";
  const signingOut = state === "signing-out" || state === "sign-out-error";
  const busy = state === "signing-in" || state === "signing-out";
  return (
    <main className="application-auth" aria-busy={busy}>
      <div className="application-auth-content">
        <h1>{checkingFailed ? "Couldn’t check access" : signingOut ? "Sign out of Superlocal" : "Sign in to Superlocal"}</h1>
        <p>{checkingFailed ? "The server couldn’t confirm your session. Try again." : signingOut ? "Your inbox is hidden while your session ends." : "Use an approved Google account."}</p>
        <button className="application-auth-button" type="button" disabled={busy} onClick={() => { if (checkingFailed) void refresh(true); else if (signingOut) void signOut(); else void signIn(); }}>
          {checkingFailed ? "Retry" : signingOut ? busy ? "Signing out…" : "Retry sign out" : busy ? "Opening Google…" : "Continue with Google"}
        </button>
        {message && <p className="application-auth-message" role="alert">{message}</p>}
      </div>
    </main>
  );
}
