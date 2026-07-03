import { useState } from "react";
import {
  identifyAuthMethod,
  loginWithPassword,
  requestOtp,
  verifyOtp,
} from "../services/complaintsApi";

export default function Login({ onLoggedIn }) {
  const [step, setStep] = useState("IDENTIFIER");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [masked, setMasked] = useState("");
  const [passwordAvailable, setPasswordAvailable] = useState(false);
  const [otpAvailable, setOtpAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const readError = (err, fallback) =>
    err?.response?.data?.message || err?.message || fallback;

  const handleIdentify = async () => {
    setError("");
    if (!identifier.trim()) {
      setError("Enter email or phone number");
      return;
    }

    try {
      setLoading(true);
      const res = await identifyAuthMethod(identifier.trim());
      setMasked(res.data?.masked || "");
      setPasswordAvailable(Boolean(res.data?.availableMethods?.password));
      setOtpAvailable(Boolean(res.data?.availableMethods?.otp));
      setStep("METHOD");
    } catch (err) {
      setError(readError(err, "Unable to identify user"));
    } finally {
      setLoading(false);
    }
  };

  const finishLogin = (res) => {
    if (!res?.token || !res?.user) {
      setError("Login failed. Please try again.");
      return;
    }
    onLoggedIn(res.token, res.user);
  };

  const handlePasswordLogin = async () => {
    setError("");
    if (!password.trim()) {
      setError("Enter password");
      return;
    }

    try {
      setLoading(true);
      finishLogin(await loginWithPassword(identifier.trim(), password));
    } catch (err) {
      setError(readError(err, "Unable to login with password"));
    } finally {
      setLoading(false);
    }
  };

  const handleRequestOtp = async () => {
    setError("");
    try {
      setLoading(true);
      await requestOtp(identifier.trim());
      setStep("OTP");
    } catch (err) {
      setError(readError(err, "Unable to send OTP"));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    setError("");
    if (!otp.trim()) {
      setError("Enter OTP");
      return;
    }

    try {
      setLoading(true);
      finishLogin(await verifyOtp(identifier.trim(), otp.trim()));
    } catch (err) {
      setError(readError(err, "Invalid OTP"));
    } finally {
      setLoading(false);
    }
  };

  const onIdentifierKeyDown = (event) => {
    if (event.key === "Enter" && step === "IDENTIFIER") handleIdentify();
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-icon">L</div>
          <div>
            <p className="brand-title">LPG Support</p>
            <p className="brand-subtitle">Agency ERP</p>
          </div>
        </div>

        <h1 className="login-heading">Sign in</h1>
        <p className="login-subtitle">Use your email or phone, then password or OTP</p>

        <label className="login-label">Email or Phone</label>
        <input
          className="login-input"
          type="text"
          value={identifier}
          disabled={step !== "IDENTIFIER"}
          onChange={(e) => setIdentifier(e.target.value)}
          onKeyDown={onIdentifierKeyDown}
          placeholder="Enter email or phone"
        />

        {step === "IDENTIFIER" && (
          <button type="button" className="login-btn" onClick={handleIdentify} disabled={loading}>
            {loading ? "Please wait..." : "Continue"}
          </button>
        )}

        {step === "METHOD" && (
          <div className="login-methods">
            <p className="login-masked">Authenticate as {masked || "user"}</p>
            {passwordAvailable && (
              <button type="button" className="login-btn" onClick={() => setStep("PASSWORD")}>
                Login with Password
              </button>
            )}
            {otpAvailable && (
              <button type="button" className="login-btn ghost" onClick={handleRequestOtp} disabled={loading}>
                {loading ? "Sending..." : "Login with OTP"}
              </button>
            )}
            {!passwordAvailable && !otpAvailable && (
              <p className="login-masked">No login method is available for this account.</p>
            )}
          </div>
        )}

        {step === "PASSWORD" && (
          <>
            <label className="login-label">Password</label>
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handlePasswordLogin()}
              placeholder="Enter password"
            />
            <button type="button" className="login-btn" onClick={handlePasswordLogin} disabled={loading}>
              {loading ? "Please wait..." : "Login"}
            </button>
            <button type="button" className="login-btn ghost" onClick={() => setStep("METHOD")}>
              Back
            </button>
          </>
        )}

        {step === "OTP" && (
          <>
            <label className="login-label">OTP</label>
            <input
              className="login-input"
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleVerifyOtp()}
              placeholder="Enter OTP"
            />
            <button type="button" className="login-btn" onClick={handleVerifyOtp} disabled={loading}>
              {loading ? "Please wait..." : "Verify OTP"}
            </button>
            <button type="button" className="login-btn ghost" onClick={handleRequestOtp} disabled={loading}>
              Resend OTP
            </button>
          </>
        )}

        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}
