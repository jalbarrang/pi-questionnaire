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

/** The choice that finishes a multi-select question. */
const DONE_CHOICE = 'Done';

/** What picking a rendered choice does. */
type Choice =
  | { readonly kind: 'listed'; readonly option: QuestionOption }
  | { readonly kind: 'other' }
  | { readonly kind: 'done' };

/**
 * Runs the questionnaire through Pi's dialog methods.
 *
 * `ctx.ui.custom()` is undefined outside the TUI, so the tabbed component in
 * `ui.ts` cannot run in RPC mode. This asks the same questions one dialog at a
 * time and returns the same result shape, so callers do not care which ran.
 */
export async function runQuestionnaireRpc(
  ctx: { ui: QuestionnaireDialogs },
  questions: NormalizedQuestion[],
): Promise<QuestionnaireResult> {
  const stateById = createInitialQuestionStateById(questions);

  for (const question of questions) {
    const state = await askQuestion(ctx.ui, question);

    // A dismissed select cancels the questionnaire, matching Escape in the TUI.
    if (state === undefined) return result(questions, stateById, null, true);

    stateById[question.id] = state;
  }

  const context = await askContext(ctx.ui);

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

async function askQuestion(
  ui: QuestionnaireDialogs,
  question: NormalizedQuestion,
): Promise<QuestionSelectionState | undefined> {
  return question.selectionMode === 'multiple'
    ? askMultiple(ui, question)
    : askSingle(ui, question);
}

async function askSingle(
  ui: QuestionnaireDialogs,
  question: NormalizedQuestion,
): Promise<QuestionSelectionState | undefined> {
  const choices = listedChoices(question);
  const labels = choices.map((choice) => choice.label);

  if (question.allowOther) labels.push(OTHER_CHOICE);

  for (;;) {
    const picked = await ui.select(question.prompt, labels);

    if (picked === undefined) return undefined;

    if (picked === OTHER_CHOICE) {
      const text = await ui.input(question.prompt, 'Type your answer');

      // Backing out or submitting nothing returns to the choices, as in the TUI.
      if (text === undefined || text.trim().length === 0) continue;

      return { listedSelectedValues: [], otherText: text, wasOtherSelected: true };
    }

    const option = choices.find((choice) => choice.label === picked)?.option;

    if (option === undefined) continue;

    return { listedSelectedValues: [option.value], otherText: '', wasOtherSelected: false };
  }
}

async function askMultiple(
  ui: QuestionnaireDialogs,
  question: NormalizedQuestion,
): Promise<QuestionSelectionState | undefined> {
  const state: QuestionSelectionState = {
    listedSelectedValues: [],
    otherText: '',
    wasOtherSelected: false,
  };

  const choices = listedChoices(question);

  for (;;) {
    const labels: string[] = [];
    const byLabel = new Map<string, Choice>();

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

    // Only offer Done once the answer is valid, so the question cannot be skipped.
    if (isAnswerValid(question, state)) {
      labels.push(DONE_CHOICE);
      byLabel.set(DONE_CHOICE, { kind: 'done' });
    }

    const picked = await ui.select(question.prompt, labels);

    if (picked === undefined) return undefined;

    const choice = byLabel.get(picked);

    if (choice === undefined) continue;
    if (choice.kind === 'done') return state;

    if (choice.kind === 'other') {
      const text = await ui.input(question.prompt, 'Type your answer');

      if (text === undefined) continue;

      state.wasOtherSelected = text.trim().length > 0;
      state.otherText = text;
      continue;
    }

    toggle(state, choice.option.value);
  }
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
