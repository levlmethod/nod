export type BrainstormParticipant = {
  name: string;
  title: string;
  tools: readonly string[];
  instructions: string;
};

export type BrainstormPlan = {
  topic: string;
  participants: BrainstormParticipant[];
  devilsAdvocate: string;
};

export type BrainstormRound = {
  round: 'ideas' | 'build' | 'devil';
  entries: Array<{ agent: string; text: string }>;
};

export type BrainstormHooks = {
  begin(input: { participants: string[]; devilsAdvocate?: string }): Promise<BrainstormPlan>;
  save(rounds: BrainstormRound[]): Promise<void>;
};
