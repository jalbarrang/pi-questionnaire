import { Type, type Static } from 'typebox';
import * as Value from 'typebox/value';

/**
 * The private questionnaire-card contract shared with the Pi VS Code panel.
 *
 * Pi's RPC protocol only carries a dialog title and a list of option strings, so
 * a rich multi-question card has to travel inside one of them. This extension
 * sends the whole questionnaire as the only option of one `select`, prefixed so
 * the panel can recognise it; the panel answers with the collected values in the
 * same envelope. A client that does not know the convention shows the raw option
 * and `rpc.ts` falls back to one question per dialog.
 */

/** Marks the single option that carries a card request. */
export const CARD_REQUEST_PREFIX = 'pi-form:v1:';

/** Marks the value the panel sends back. */
export const CARD_ANSWER_PREFIX = 'pi-form-answer:v1:';

export const CardOptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

export const CardQuestionSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  prompt: Type.String(),
  selectionMode: Type.Union([Type.Literal('single'), Type.Literal('multiple')]),
  allowOther: Type.Boolean(),
  options: Type.Array(CardOptionSchema),
});

export const CardRequestSchema = Type.Object({
  title: Type.String(),
  questions: Type.Array(CardQuestionSchema),
});

export type CardRequest = Static<typeof CardRequestSchema>;

export const CardAnswerSchema = Type.Object({
  answers: Type.Array(
    Type.Object({
      id: Type.String(),
      values: Type.Array(Type.String()),
      other: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  context: Type.Union([Type.String(), Type.Null()]),
  cancelled: Type.Boolean(),
});

export type CardAnswer = Static<typeof CardAnswerSchema>;

/** Wraps a request as the single option of a card select. */
export function encodeCardRequest(request: CardRequest): string {
  return `${CARD_REQUEST_PREFIX}${JSON.stringify(request)}`;
}

/** Reads the panel's answer, or undefined when the client did not understand. */
export function decodeCardAnswer(value: string): CardAnswer | undefined {
  if (!value.startsWith(CARD_ANSWER_PREFIX)) return undefined;

  try {
    const parsed = JSON.parse(value.slice(CARD_ANSWER_PREFIX.length));

    if (!Value.Check(CardAnswerSchema, parsed)) return undefined;

    return Value.Decode(CardAnswerSchema, parsed);
  } catch {
    return undefined;
  }
}
