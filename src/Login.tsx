import { useState, type FormEvent } from "react";
import {
  BookOpen,
  Check,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  WifiOff,
} from "lucide-react";
import "./login.css";

export default function Login({
  online,
  notice,
  canBrowse,
  onBrowse,
  onLogin,
}: {
  online: boolean;
  notice: string;
  canBrowse: boolean;
  onBrowse: () => void;
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!online || busy) return;
    setBusy(true);
    setError("");
    try {
      await onLogin(email, password);
      setPassword("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-icon">
            <BookOpen size={26} />
          </span>
          booxs<span>.</span>
        </div>
        <span className="eyebrow">YOUR STORIES, JUST FOR YOU</span>
        <h1>
          Welcome to
          <br />
          your bookshelf<span>.</span>
        </h1>
        <p className="login-intro">
          A little home for every book in your life.
          <br />
          Sign in to pick up where you left off.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
            placeholder="you@example.com"
          />
          <label htmlFor="login-password">Password</label>
          <div className="password-input">
            <input
              id="login-password"
              type={visible ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={1024}
              placeholder="Your Booxs password"
            />
            <button
              type="button"
              className="icon-button"
              aria-label={visible ? "Hide password" : "Show password"}
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {!online && (
            <p className="message">
              <WifiOff size={17} />
              Connect to the internet to sign in.
            </p>
          )}
          {(error || notice) && (
            <p className="message error" role="alert">
              {error || notice}
            </p>
          )}
          <button className="button primary full" disabled={!online || busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <LockKeyhole size={17} />
            )}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {canBrowse && (
          <button className="text-button browse-offline" onClick={onBrowse}>
            Browse downloaded books
          </button>
        )}
        <div className="login-footnote">
          <Check size={14} />
          Your private library. One owner. No registration.
        </div>
      </div>
    </main>
  );
}
