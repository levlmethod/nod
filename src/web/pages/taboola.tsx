import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { usePageData } from '../hooks/use-page-data';

type Connections = {
  connections: Array<{ id: string; accountId: string; accountName: string; connectedAt: string }>;
};

const path = '/api/agents/taboola';

export function TaboolaConnections() {
  const { data, refresh } = usePageData<Connections>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(change: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await change();
      await refresh();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const saved = await run(() =>
      api(path, {
        method: 'POST',
        body: JSON.stringify({
          clientId: fields.get('clientId'),
          clientSecret: fields.get('clientSecret'),
          accountId: fields.get('accountId'),
        }),
      }),
    );
    if (saved) form.reset();
  }

  return (
    <section className="board-client board-connections" aria-label="Taboola">
      <header>
        <h2>Taboola</h2>
      </header>
      <p className="muted">
        Watchers read Taboola spend and performance through these read-only connections. Add the
        account to a client file with service taboola and the account ID below.
      </p>
      {data?.connections.length ? (
        <ul>
          {data.connections.map((connection) => (
            <li key={connection.id}>
              {connection.accountName} · {connection.accountId}{' '}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => run(() => api(`${path}/${connection.id}`, { method: 'DELETE' }))}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="board-connection-form" onSubmit={connect}>
        <Field label="Client ID">
          <Input name="clientId" required minLength={8} autoComplete="off" />
        </Field>
        <Field label="Client secret">
          <Input name="clientSecret" type="password" required minLength={8} autoComplete="off" />
        </Field>
        <Field label="Account ID" hint="The advertiser account_id, such as rkmd-sc.">
          <Input name="accountId" required autoComplete="off" />
        </Field>
        <Button type="submit" disabled={busy}>
          Connect Taboola
        </Button>
      </form>
      {error && <Notice>{error}</Notice>}
    </section>
  );
}
