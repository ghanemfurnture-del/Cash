import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, PlusSquare, X } from 'lucide-react';

const IOS_PROMPT_STORAGE_KEY = 'cash_erp_ios_install_dismissed';

export const IosInstallDrawer: React.FC = () => {
  const { t } = useTranslation();
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // Detect iOS devices
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    // Check if running inside standalone PWA mode
    const isStandalone = (window.navigator as any).standalone === true;
    const isDismissed = localStorage.getItem(IOS_PROMPT_STORAGE_KEY) === 'true';

    if (isIos && !isStandalone && !isDismissed) {
      setShowPrompt(true);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(IOS_PROMPT_STORAGE_KEY, 'true');
    setShowPrompt(false);
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-4 bg-background/95 backdrop-blur-md border-t border-border shadow-2xl animate-in slide-in-from-bottom duration-300">
      <div className="max-w-md mx-auto space-y-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h4 className="font-semibold text-sm text-foreground">{t('ios.install_title')}</h4>
            <p className="text-xs text-muted-foreground">{t('ios.install_desc')}</p>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 rounded-full text-muted-foreground hover:bg-muted transition-colors"
            aria-label="إغلاق التنبيه"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2 text-xs bg-muted/50 p-3 rounded-lg border border-border/50">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
              <Share className="w-4 h-4" />
            </div>
            <span>{t('ios.step1')}</span>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
              <PlusSquare className="w-4 h-4" />
            </div>
            <span>{t('ios.step2')}</span>
          </div>
        </div>

        <button
          onClick={handleDismiss}
          className="w-full py-2 px-3 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t('ios.dismiss')}
        </button>
      </div>
    </div>
  );
};

