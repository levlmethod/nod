import type { Pool, PoolClient } from 'pg';
import type { BrowserConnectionRequest } from '../../ports/agent.ts';
import type { TurnRef } from '../thread.ts';
import { browserOf } from '../turn-chain.ts';

type Card = { agent: string; client: string | null };
type Launch = { timeZone?: string; locale?: string };
type Open = (
  request: BrowserConnectionRequest,
  turn: TurnRef,
  signal?: AbortSignal,
  launch?: Launch,
) => Promise<unknown>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentBrowserProfiles(options: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  underTurn?: (
    turnId: string,
    write: (client: Pick<PoolClient, 'query'>) => Promise<unknown>,
  ) => Promise<unknown>;
}) {
  const { pool, ownerId } = options;
  const underTurn = options.underTurn ?? ((_turnId, write) => write(pool));

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_browser_profiles (
        connection_id uuid PRIMARY KEY,
        owner_id text NOT NULL,
        agent text NOT NULL,
        client text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS agent_browser_profiles_owner
        ON agent_browser_profiles(owner_id,agent,client);
    `);
  }

  async function cardOf(turn: TurnRef): Promise<Card | undefined> {
    return (
      await pool.query<Card>(
        `SELECT c.agent,c.client FROM turns u
         JOIN tasks t ON t.session_id=u.session_id AND t.owner_id=u.owner_id
         JOIN agent_cards c ON c.task_id=t.id AND c.owner_id=t.owner_id
         WHERE u.id=$1 AND u.owner_id=$2`,
        [turn.turnId, ownerId],
      )
    ).rows[0];
  }

  async function owned(agent: string, client: string | null): Promise<ReadonlySet<string>> {
    if (!client) return new Set();
    const rows = await pool.query<{ connection_id: string }>(
      `SELECT p.connection_id FROM agent_browser_profiles p
       JOIN browser_connections b ON b.id=p.connection_id AND b.owner_id=p.owner_id
       WHERE p.owner_id=$1 AND p.agent=$2 AND p.client=$3 AND b.state<>'disconnecting'`,
      [ownerId, agent, client],
    );
    return new Set(rows.rows.map((row) => row.connection_id));
  }

  const noClient = (card: Card) =>
    new Error(
      `This ${card.agent} card has no client, so it can't use saved browser profiles: each profile belongs to one agent and one client. Restart the card for a client.`,
    );

  function browserConnection(open: Open): Open {
    return async (request, turn, signal, launch) => {
      const card = await cardOf(turn);
      if (!card) return open(request, turn, signal, launch);
      if (!card.client) throw noClient(card);
      if (request.action === 'connect') {
        let site = request.label;
        if (!site)
          try {
            site = new URL(request.url).hostname;
          } catch {
            return open(request, turn, signal, launch);
          }
        const result = (await open(
          { ...request, label: `${card.client} · ${card.agent}: ${site}` },
          turn,
          signal,
          launch,
        )) as { connectionId?: unknown };
        const connectionId = result?.connectionId;
        if (typeof connectionId === 'string')
          await underTurn(turn.turnId, (client) =>
            client.query(
              `INSERT INTO agent_browser_profiles(connection_id,owner_id,agent,client)
               VALUES($1,$2,$3,$4)`,
              [connectionId, ownerId, card.agent, card.client],
            ),
          );
        return result;
      }
      if (typeof request.connectionId !== 'string' || !uuid.test(request.connectionId))
        return open(request, turn, signal, launch);
      const profile = (
        await pool.query<Card>(
          'SELECT agent,client FROM agent_browser_profiles WHERE connection_id=$1 AND owner_id=$2',
          [request.connectionId, ownerId],
        )
      ).rows[0];
      if (!profile)
        throw new Error(
          `Browser profile ${request.connectionId} isn't one of ${card.agent}'s profiles for ${card.client}, so this card can't open it. Cards open only profiles their own agent made for their client; use connect {url} to make one.`,
        );
      if (profile.agent !== card.agent || profile.client !== card.client)
        throw new Error(
          `Browser profile ${request.connectionId} belongs to ${profile.agent} for ${profile.client}, not ${card.agent} for ${card.client}. Each agent keeps its own signed-in profile per client, so this card can't open it.`,
        );
      return open(request, turn, signal, launch);
    };
  }

  async function signIn(
    turn: TurnRef,
    input: { kind: string; savedLoginId?: string; emailCode?: boolean },
  ) {
    const card = await cardOf(turn);
    if (!card) return false;
    if (!card.client) throw noClient(card);
    if (input.savedLoginId)
      throw new Error(
        `Saved logins belong to the owner, not to ${card.client}, so a card can't use one. Omit savedLoginId: the owner signs in privately once and ${card.agent}'s profile for ${card.client} keeps the session.`,
      );
    if (input.kind === 'otp' && input.emailCode)
      throw new Error(
        `Email codes are read from the owner's mailbox, which holds every client's mail, so a card can't fetch one. Omit emailCode and the owner enters the code privately.`,
      );
    const open = await pool.query(
      `SELECT 1 FROM browser_connections b
       JOIN agent_browser_profiles p ON p.connection_id=b.id AND p.owner_id=b.owner_id
       WHERE b.owner_id=$1 AND b.browser_id=$2 AND p.agent=$3 AND p.client=$4
       AND b.state<>'disconnecting'`,
      [ownerId, browserOf(turn), card.agent, card.client],
    );
    if (!open.rowCount)
      throw new Error(
        `A card signs in only inside its own saved browser profile, so the sign-in stays with ${card.agent} for ${card.client}. Open one first with browser_session connect {url}, or use {url, connectionId} for a profile listed in your connections.`,
      );
    return true;
  }

  return { initialize, cardOf, owned, browserConnection, signIn };
}
