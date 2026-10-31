import React from 'react';
import { LucideIcon } from 'lucide-react';

interface ModulePlaceholderProps {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  badge?: string;
}

export const ModulePlaceholder: React.FC<ModulePlaceholderProps> = ({
  title,
  subtitle,
  icon: Icon,
  badge = 'المرحلة القادمة',
}) => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center space-y-4 rounded-2xl bg-card border border-border border-dashed">
      <div className="p-4 rounded-2xl bg-primary/10 text-primary">
        <Icon className="w-10 h-10" />
      </div>
      <div className="space-y-1">
        <div className="inline-block px-2.5 py-0.5 mb-2 text-xs font-semibold rounded-full bg-muted text-muted-foreground">
          {badge}
        </div>
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground max-w-sm">{subtitle}</p>
      </div>
    </div>
  );
};

