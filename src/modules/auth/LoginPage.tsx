import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Mail, ArrowRight, Building2, AlertCircle } from 'lucide-react';
import { useAuth } from '../../core/auth';
import { IS_DEV_MOCK_AUTH_ENABLED } from '../../lib/supabase';

export const LoginPage: React.FC<{ onLoginSuccess?: () => void }> = ({ onLoginSuccess }) => {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('يرجى إدخال البريد الإلكتروني وكلمة المرور.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await login(email, password);
      if (onLoginSuccess) onLoginSuccess();
    } catch (err: any) {
      setError(err?.message || 'تعذر تسجيل الدخول. يرجى التحقق من اتصالك وبياناتك.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-3xl shadow-xl p-6 sm:p-8 space-y-6">
        {/* App Logo & Header */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-2xl mx-auto shadow-md">
            خ
          </div>
          <h1 className="text-xl font-bold text-foreground">نظام الخزينة والمحاسبة</h1>
          <p className="text-xs text-muted-foreground">تسجيل الدخول الموحد (Supabase Auth)</p>
          {IS_DEV_MOCK_AUTH_ENABLED && (
            <span className="inline-block px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-600 rounded-full font-bold">
              وضع التطوير التجريبي مفعّل (Dev Mock Auth Active)
            </span>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-muted-foreground" />
              <span>{t('auth.email')}</span>
            </label>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
              className="w-full px-3 py-2 text-xs rounded-xl border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground"
              placeholder="user@company.com"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-muted-foreground" />
              <span>{t('auth.password')}</span>
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              className="w-full px-3 py-2 text-xs rounded-xl border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 text-xs font-bold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-2 shadow-xs disabled:opacity-50 cursor-pointer"
          >
            <span>{loading ? 'جارِ التحقق...' : t('auth.login')}</span>
            <ArrowRight className="w-4 h-4 rtl:rotate-180" />
          </button>

          {/* Clear Arabic Error Message Rendered Directly Under The Submit Button */}
          {error && (
            <div
              role="alert"
              className="p-3 text-xs rounded-xl bg-destructive/10 text-destructive border border-destructive/20 flex items-start gap-2 animate-in fade-in slide-in-from-top-1 duration-200"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="font-semibold leading-relaxed">{error}</span>
            </div>
          )}
        </form>

        <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground pt-2 border-t border-border/70">
          <Building2 className="w-3 h-3 text-emerald-600" />
          <span>جلسة العمل محمية ومتاحة للعمل دون إنترنت بعد أول تسجيل</span>
        </div>
      </div>
    </div>
  );
};
