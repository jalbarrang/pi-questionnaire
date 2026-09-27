import { decodeCardAnswer, encodeCardRequest, type CardAnswer, type CardRequest } from './card.js';
import { createInitialQuestionStateById, isAnswerValid, normalizeAnswers } from './format.js';
import type {
  NormalizedQuestion,
  QuestionOption,
  QuestionnaireResult,
  QuestionSelectionState,
} from './types.js';

/** The dialog methods the RPC flow needs. `ui.ts` owns the rest of the UI. */
export interface QuestionnaireDialogs {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** The choice that opens free-text "Other" input. */
const OTHER_CHOICE = 'Other (type your own)…';

/** Title of the card select; the whole questionnaire rides in its one option. */
const CARD_TITLE = 'Questionnaire';

/** Navigation choices a step adds to its own options. */
const BACK_CHOICE = '← Back';
const CONTINUE_CHOICE = 'Continue →';
const FINISH_CHOICE = 'Finish ✓';

/** How the user left a step. */
type StepAction = 'next' | 'back' | 'cancelled';

/** What picking a rendered choice does. */
type StepChoice =
  | { readonly kind: 'listed'; readonly option: QuestionOption }
  | { readonly kind: 'other' }
  | { readonly kind: 'back' }
  | { readonly kind: 'advance' };

/**
 * Runs the questionnaire through Pi's dialog methods.
 *
 * `ctx.ui.custom()` is undefined outside the TUI, so the tabbed component in
 * `ui.ts` cannot run in RPC mode. This walks the questions one dialog at a time
 * and keeps every answer, so Back returns to a step with its selection intact.
 * It returns the same result shape as the TUI, so callers do not care which ran.
 */
export async function runQuestionnaireRpc(
  ctx: { ui: QuestionnaireDialogs },
  questions: NormalizedQuestion[],
): Promise<QuestionnaireResult> {
  // A client that speaks the card convention renders one form and answered every
  // question already; anything else falls through to the stepper below.
  const card = await askWithCard(ctx.ui, questions);

  if (card !== undefined) return card;

  return runStepper(ctx.ui, questions);
}

/**
 * Asks the whole questionnaire as one card select.
 *
 * Returns `undefined` when the client answered with something other than a card
 * answer, which means it does not know the convention and should get the stepper.
 */
async function askWithCard(
  ui: QuestionnaireDialogs,
  questions: NormalizedQuestion[],
): Promise<QuestionnaireResult | undefined> {
  const answer = await ui.select(CARD_TITLE, [encodeCardRequest(toCardRequest(questions))]);

  if (answer === undefined) {
    return result(questions, createInitialQuestionStateById(questions), null, true);
  }

  const decoded = decodeCardAnswer(answer);

  if (decoded === undefined) return undefined;

  return cardResult(questions, decoded);
}

function cardResult(questions: NormalizedQuestion[], answer: CardAnswer): QuestionnaireResult {
  const stateById = createInitialQuestionStateById(questions);

  for (const entry of answer.answers) {
    const state = stateById[entry.id];

    if (state === undefined) continue;

    state.listedSelectedValues = entry.values;
    state.otherText = entry.other ?? '';
    state.wasOtherSelected = entry.other !== null && entry.other.trim().length > 0;
  }

  return {
    questions,
    answers: normalizeAnswers(questions, stateById),
    context: answer.context,
    cancelled: answer.cancelled,
  };
}

function toCardRequest(questions: NormalizedQuestion[]): CardRequest {
  return {
    title: 'Questions',
    questions: questions.map((question) => ({
      id: question.id,
      label: question.label,
      prompt: question.prompt,
      selectionMode: question.selectionMode,
      allowOther: question.allowOther,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

/** One question per dialog, for clients that do not render the card. */
async function runStepper(
  ui: QuestionnaireDialogs,
  questions: NormalizedQuestion[],
): Promise<QuestionnaireResult> {
  const stateById = createInitialQuestionStateById(questions);
  let index = 0;

  while (index >= 0 && index < questions.length) {
    const question = questions[index];
    const step = { index, total: questions.length };
    const action =
      question.selectionMode === 'multiple'
        ? await askMultiple(ui, question, step, stateById[question.id])
        : await askSingle(ui, question, step, stateById[question.id]);

    // A dismissed select cancels the questionnaire, matching Escape in the TUI.
    if (action === 'cancelled') return result(questions, stateById, null, true);

    index += action === 'back' ? -1 : 1;
  }

  const context = await askContext(ui);

  return result(questions, stateById, context, false);
}

function result(
  questions: NormalizedQuestion[],
  stateById: Record<string, QuestionSelectionState>,
  context: string | null,
  cancelled: boolean,
): QuestionnaireResult {
  return { questions, answers: normalizeAnswers(questions, stateById), context, cancelled };
}

/** A single-select step advances as soon as an option is chosen. */
async function askSingle(
  ui: QuestionnaireDialogs,
  question: NormalizedQuestion,
  step: { index: number; total: number },
  state: QuestionSelectionState,
): Promise<StepAction> {
  const choices = listedChoices(question);

  for (;;) {
    const labels: string[] = [];
    const byLabel = new Map<string, StepChoice>();

    for (const choice of choices) {
      const selected = state.listedSelectedValues.includes(choice.option.value);
      const label = `${selected ? '●' : '○'} ${choice.label}`;
      labels.push(label);
      byLabel.set(label, { kind: 'listed', option: choice.option });
    }

    if (question.allowOther) {
      const label = `${state.wasOtherSelected ? '●' : '○'} ${otherLabel(state)}`;
      labels.push(label);
      byLabel.set(label, { kind: 'other' });
    }

    addBackChoice(labels, byLabel, step.index);

    const picked = await ui.select(stepTitle(step, question.prompt), labels);

    if (picked === undefined) return 'cancelled';

    const choice = byLabel.get(picked);

    if (choice === undefined) continue;
    if (choice.kind === 'back') return 'back';

    if (choice.kind === 'other') {
      const text = await ui.input(question.prompt, 'Type your answer');

      // Backing out or submitting nothing returns to the choices, as in the TUI.
      if (text === undefined || text.trim().length === 0) continue;

      state.listedSelectedValues = [];
      state.otherText = text;
      state.wasOtherSelected = true;

      return 'next';
    }

    if (choice.kind === 'listed') {
      state.listedSelectedValues = [choice.option.value];
      state.otherText = '';
      state.wasOtherSelected = false;

      return 'next';
    }
  }
}

/** A multi-select step toggles options and advances on Continue or Finish. */
async function askMultiple(
  ui: QuestionnaireDialogs,
  question: NormalizedQuestion,
  step: { index: number; total: number },
  state: QuestionSelectionState,
): Promise<StepAction> {
  const choices = listedChoices(question);

  for (;;) {
    const labels: string[] = [];
    const byLabel = new Map<string, StepChoice>();

    for (const choice of choices) {
      const selected = state.listedSelectedValues.includes(choice.option.value);
      const label = `${selected ? '[x]' : '[ ]'} ${choice.label}`;
      labels.push(label);
      byLabel.set(label, { kind: 'listed', option: choice.option });
    }

    if (question.allowOther) {
      const label = `${state.wasOtherSelected ? '[x]' : '[ ]'} ${otherLabel(state)}`;
      labels.push(label);
      byLabel.set(label, { kind: 'other' });
    }

    addBackChoice(labels, byLabel, step.index);

    // Only offer Continue once the answer is valid, so the question cannot be skipped.
    if (isAnswerValid(question, state)) {
      const advance = step.index === step.total - 1 ? FINISH_CHOICE : CONTINUE_CHOICE;
      labels.push(advance);
      byLabel.set(advance, { kind: 'advance' });
    }

    const picked = await ui.select(stepTitle(step, question.prompt), labels);

    if (picked === undefined) return 'cancelled';

    const choice = byLabel.get(picked);

    if (choice === undefined) continue;
    if (choice.kind === 'back') return 'back';
    if (choice.kind === 'advance') return 'next';

    if (choice.kind === 'other') {
      const text = await ui.input(question.prompt, 'Type your answer');

      if (text === undefined) continue;

      state.wasOtherSelected = text.trim().length > 0;
      state.otherText = text;
      continue;
    }

    if (choice.kind === 'listed') toggle(state, choice.option.value);
  }
}

function addBackChoice(labels: string[], byLabel: Map<string, StepChoice>, index: number): void {
  if (index === 0) return;

  labels.push(BACK_CHOICE);
  byLabel.set(BACK_CHOICE, { kind: 'back' });
}

/** The step's prompt, shown with its position so Back and Continue make sense. */
function stepTitle(step: { index: number; total: number }, prompt: string): string {
  return `Question ${step.index + 1} of ${step.total}: ${prompt}`;
}

function toggle(state: QuestionSelectionState, value: string): void {
  const selected = new Set(state.listedSelectedValues);

  if (selected.has(value)) selected.delete(value);
  else selected.add(value);

  state.listedSelectedValues = [...selected];
}

/** Display labels are unique: a repeated label gains its value in parentheses. */
function listedChoices(question: NormalizedQuestion): { label: string; option: QuestionOption }[] {
  const counts = new Map<string, number>();

  for (const option of question.options) {
    const label = displayLabel(option);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return question.options.map((option) => {
    const label = displayLabel(option);

    return {
      label: (counts.get(label) ?? 0) > 1 ? `${label} (${option.value})` : label,
      option,
    };
  });
}

function displayLabel(option: QuestionOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function otherLabel(state: QuestionSelectionState): string {
  const text = state.otherText.trim();

  return text ? `Other: "${text}"` : OTHER_CHOICE;
}

async function askContext(ui: QuestionnaireDialogs): Promise<string | null> {
  const text = await ui.input(
    'Anything else? (optional)',
    'Add extra context, or press Esc to skip',
  );
  const trimmed = text?.trim();

  return trimmed ? trimmed : null;
}
