import { useState } from 'react';
import type {
  Board as BoardData,
  BoardCard,
  BoardCardDetail,
  BoardState,
} from '../../shared/board';
import { PageTitle } from '../components/page-title';
import { Loading, Notice } from '../components/ui';
import { MessageText } from '../components/message';
import { usePageData } from '../hooks/use-page-data';
import { money } from '../lib/money';
import { TaskActivity } from './tasks';
import { TaboolaConnections } from './taboola';
import './board.css';

const labels: Record<BoardState, string> = {
  blocked: 'Blocked',
  needs_you: 'Waiting on you',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  scheduled: 'Scheduled',
  failed: 'Failed',
  done: 'Done',
  stopped: 'Stopped',
};

const minutes = (value: number) =>
  value < 60
    ? `${value} min`
    : `${Math.floor(value / 60)} h${value % 60 ? ` ${value % 60} min` : ''}`;

function CardDetail({ id }: { id: string }) {
  const { data, error } = usePageData<BoardCardDetail>(`/api/board/cards/${id}`);
  if (error) return <Notice>Could not load this card: {error}</Notice>;
  if (!data) return <Loading label="Loading card…" />;
  const { result } = data;
  return (
    <div className="board-card-detail">
      {data.doneWhen && (
        <p>
          <strong>Done when</strong> {data.doneWhen}
        </p>
      )}
      {result && (
        <section aria-label="Result">
          <h4>{'question' in result ? 'Question for you' : 'Result'}</h4>
          {'question' in result ? (
            <MessageText text={result.question} />
          ) : (
            <>
              <MessageText text={result.conclusion} />
              <ul>
                {result.evidence.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
              <p>
                <strong>Next</strong> {result.nextAction} · <strong>Confidence</strong>{' '}
                {result.confidence}
              </p>
            </>
          )}
        </section>
      )}
      {data.children.length > 0 && (
        <section aria-label="Child cards">
          <h4>Child cards</h4>
          <ul>
            {data.children.map((child) => (
              <li key={child.id}>
                {child.title} · {child.agent} ·{' '}
                <span className="board-state" data-state={child.state}>
                  {labels[child.state]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Asks">
        <h4>Asks</h4>
        {data.asks.length ? (
          data.asks.map((ask) => (
            <div key={ask.agent} className="board-ask" data-flagged={ask.flagged}>
              <p>
                <strong>{ask.agent}</strong>
                {ask.flagged ? ' · flagged for the PM' : ''}
              </p>
              <ol>
                {ask.exchanges.map((exchange, index) => (
                  <li key={index}>
                    <p>Q: {exchange.question}</p>
                    <p>
                      A:{' '}
                      {exchange.unanswered
                        ? 'No answer'
                        : (exchange.answer ?? 'Waiting for answer')}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          ))
        ) : (
          <p className="muted">None.</p>
        )}
      </section>
      <section aria-label="PM actions">
        <h4>PM actions</h4>
        {data.pmActions.length ? (
          <ul>
            {data.pmActions.map((action, index) => (
              <li key={index}>
                <strong>{action.action}</strong> · {action.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None.</p>
        )}
      </section>
      <section aria-label="Activity">
        <h4>Activity</h4>
        <TaskActivity id={id} />
      </section>
    </div>
  );
}

function Card({ card }: { card: BoardCard }) {
  const [open, setOpen] = useState(false);
  const over = card.agentMinutes > card.estimateMinutes;
  return (
    <details
      className="board-card"
      data-state={card.state}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="board-card-title">{card.title}</span>
        <span className="board-state" data-state={card.state}>
          {labels[card.state]}
        </span>
        <span className="board-card-facts">
          <span>{card.agentTitle}</span>
          <span data-over={over}>
            {minutes(card.agentMinutes)} of {minutes(card.estimateMinutes)}
          </span>
          {card.waitingMinutes > 0 && <span>Waited on you {minutes(card.waitingMinutes)}</span>}
          <span>
            {money(card.spendUsd)}
            {card.budgetUsd !== null ? ` of ${money(card.budgetUsd)}` : ''}
          </span>
          {card.flaggedAsks > 0 && <span data-flagged="true">Ask flagged</span>}
        </span>
        {card.blockers.length > 0 && (
          <span className="board-card-blockers">
            Blocked by {card.blockers.map((blocker) => blocker.title).join(', ')}
          </span>
        )}
      </summary>
      {open && <CardDetail id={card.id} />}
    </details>
  );
}

export function Board() {
  const { data, error } = usePageData<BoardData>('/api/board');
  return (
    <div className="content-page secondary-page board-page">
      <header className="page-heading secondary-heading">
        <PageTitle path="/board" />
      </header>
      {error ? (
        <Notice>Could not load the board: {error}</Notice>
      ) : !data ? (
        <Loading label="Loading board…" />
      ) : !data.enabled ? (
        <Notice>Agents are off, so there are no cards. Set NOD_AGENTS_ROOT to turn them on.</Notice>
      ) : (
        <>
          <p className="muted">
            Open cards and cards closed in the last {data.recentDays} days, by client and team.
          </p>
          {data.clients.map((client) => (
            <section key={client.client} className="board-client" aria-label={client.title}>
              <header>
                <h2>{client.title}</h2>
                {client.capUsd !== null && (
                  <span className="board-spend" data-paused={Boolean(client.paused)}>
                    {money(client.spentUsd ?? 0)} of {money(client.capUsd)} this month
                    {client.paused ? ' · paused' : ''}
                  </span>
                )}
              </header>
              {client.paused && <Notice>{client.paused}</Notice>}
              {client.teams.length ? (
                client.teams.map((team) => (
                  <section key={team.team} className="board-team" aria-label={team.title}>
                    <h3>{team.title}</h3>
                    {team.cards.map((card) => (
                      <Card key={card.id} card={card} />
                    ))}
                  </section>
                ))
              ) : (
                <p className="muted">No cards.</p>
              )}
            </section>
          ))}
          <TaboolaConnections />
        </>
      )}
    </div>
  );
}
