import { PasswordForm } from '../account/PasswordForm';
import { PushToggle } from '../account/PushToggle';
import { TwoFactor } from '../account/TwoFactor';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABEL } from '../auth/permissions';
import { useT } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { Panel } from '../ui/Panel';
import { useToast } from '../ui/Toast';

export function AccountPage() {
  const { t } = useT();
  const { user } = useAuth();
  const toast = useToast();
  if (!user) return null;
  return (
    <>
      <PageHeader
        title={t('page.account.title')}
        subtitle={`${user.name} · ${user.email} · ${ROLE_LABEL[user.role]}`}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Password">
          <PasswordForm onDone={() => toast({ tone: 'success', title: 'Password changed' })} />
        </Panel>
        <Panel title="Two-factor sign-in">
          <TwoFactor />
        </Panel>
        <Panel title="Notifications">
          <PushToggle />
        </Panel>
      </div>
    </>
  );
}
