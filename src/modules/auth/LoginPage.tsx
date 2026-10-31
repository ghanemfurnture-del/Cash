import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Lock, Mail, ArrowRight, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../core/auth';

export const LoginPage: React.FC<{ onLoginSuccess?: () => void }> = ({ onLoginSuccess }) => {
  const { t } = useTranslation();
  const { loginOffline } = useAuth();
  const [email, setEmail] = useState('admin@cash.local');
  const [password, setPassword] = useState('admin123');
  const [pin, setPin] = useState('');
  const [usePinMode, setUsePinMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const success = await loginOffline(email, pin);
      if (success) {
        if (onLoginSuccess) onLoginSuccess();
      } else {
        setError('تعذر تسجيل الدخول بالبيانات المدخلة');
      }
    } catch {
      setError('حدث خطأ أثناء تسجيل الدخول');
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
          <p className="text-xs text-muted-foreground">تسجيل الدخول للنظام (يعمل دون إنترنت)</p>
        </div>

        {error && (
          <div className="p-3 text-xs rounded-xl bg-destructive/10 text-destructive border border-destructive/20 text-center font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!usePinMode ? (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                  <span>{t('auth.email')}</span>
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition-all"
                  placeholder="admin@cash.local"
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
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition-all"
                  placeholder="••••••••"
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
                <span>رمز المرور السريع (PIN لهذا الجهاز)</span>
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="w-full px-3 py-2 text-center text-lg tracking-widest rounded-xl border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition-all font-mono"
                placeholder="••••"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 text-xs font-bold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-2 shadow-xs disabled:opacity-50"
          >
            <span>{loading ? 'جارِ التحقق...' : t('auth.login')}</span>
            <ArrowRight className="w-4 h-4 rtl:rotate-180" />
          </button>
        </form>

        <div className="pt-2 border-t border-border/70 text-center">
          <button
            type="button"
            onClick={() => setUsePinMode(!usePinMode)}
            className="text-xs text-primary hover:underline font-medium"
          >
            {usePinMode ? 'تسجيل الدخول بالبريد وكلمة المرور' : 'الدخول السريع برمز الجهاز (PIN)'}
          </button>
        </div>

        <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <Building2 className="w-3 h-3 text-emerald-600" />
          <span>{t('auth.offline_ready')}</span>
        </div>
      </div>
    </div>
  );
};
