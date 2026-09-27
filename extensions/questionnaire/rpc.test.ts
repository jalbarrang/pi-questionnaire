import { describe, expect, test } from 'bun:test';

import { normalizeQuestions } from './format.js';
import { runQuestionnaireRpc, type QuestionnaireDialogs } from './rpc.js';
import type { NormalizedQuestion, QuestionInput } from './types.js';

/** Navigation and free-text choices the RPC flow renders. */
const OTHER = 'Other (type your own)…';
const BACK = '← Back';
const FINISH = 'Finish ✓';

/** A stand-in for `ctx.ui` that answers dialogs from a scripted queue. */
function fakeUi(selects: (string | undefined)[], inputs: (string | undefined)[] = []) {
  const selectCalls: { title: string; options: string[] }[] = [];

  const ui: QuestionnaireDialogs = {
    select: (title, options) => {
      selectCalls.push({ title, options });
      return Promise.resolve(selects.shift());
    },
    input: () => Promise.resolve(inputs.shift()),
  };

  return { ui, selectCalls };
}

function normalize(input: QuestionInput[]): NormalizedQuestion[] {
  return normalizeQuestions(input);
}

const singleQuestion = normalize([
  {
    id: 'scope',
    label: 'Scope',
    prompt: 'What is the scope?',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
]);

const twoQuestions = normalize([
  {
    id: 'scope',
    prompt: 'What is the scope?',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
  {
    id: 'ship',
    prompt: 'Should we ship?',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
]);

const multiQuestion = normalize([
  {
    id: 'areas',
    label: 'Areas',
    prompt: 'Which areas?',
    selectionMode: 'multiple',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  },
]);

describe('runQuestionnaireRpc', () => {
  test('records the chosen option and numbers the step', async () => {
    const { ui, selectCalls } = fakeUi(['○ High']);

    const result = await runQuestionnaireRpc({ ui }, singleQuestion);

    expect(result.cancelled).toBe(false);
    expect(result.answers[0]?.selectedOptions).toEqual([{ value: 'high', label: 'High' }]);
    expect(selectCalls[0]?.title).toBe('Question 1 of 1: What is the scope?');
    expect(selectCalls[0]?.options).toEqual(['○ Low', '○ High', `○ ${OTHER}`]);
  });

  test('maps an Other choice to free text', async () => {
    const { ui } = fakeUi([`○ ${OTHER}`], ['GraphQL']);

    const result = await runQuestionnaireRpc({ ui }, singleQuestion);

    expect(result.answers[0]?.otherText).toBe('GraphQL');
    expect(result.answers[0]?.wasOtherSelected).toBe(true);
    expect(result.answers[0]?.selectedOptions).toEqual([]);
  });

  test('cancels the questionnaire when a question is dismissed', async () => {
    const { ui } = fakeUi([undefined]);

    const result = await runQuestionnaireRpc({ ui }, singleQuestion);

    expect(result.cancelled).toBe(true);
    expect(result.answers[0]?.selectedOptions).toEqual([]);
  });

  test('goes back to a previous step with its answer prefilled', async () => {
    const { ui, selectCalls } = fakeUi(['○ High', BACK, '● High', '○ Yes']);

    const result = await runQuestionnaireRpc({ ui }, twoQuestions);

    expect(result.answers.map((answer) => answer.selectedOptions[0]?.value)).toEqual([
      'high',
      'yes',
    ]);
    // The return to step one marks the previous choice instead of starting over.
    expect(selectCalls[2]?.title).toBe('Question 1 of 2: What is the scope?');
    expect(selectCalls[2]?.options).toContain('● High');
  });

  test('toggles several options and finishes on Finish', async () => {
    const { ui } = fakeUi(['[ ] Low', '[ ] High', FINISH]);

    const result = await runQuestionnaireRpc({ ui }, multiQuestion);

    expect(result.answers[0]?.selectedOptions).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ]);
  });

  test('keeps an Other answer in a multi question', async () => {
    const { ui } = fakeUi([`[ ] ${OTHER}`, FINISH], ['graphql']);

    const result = await runQuestionnaireRpc({ ui }, multiQuestion);

    expect(result.answers[0]?.otherText).toBe('graphql');
    expect(result.answers[0]?.wasOtherSelected).toBe(true);
  });

  test('returns the optional context', async () => {
    const { ui } = fakeUi(['○ High'], ['be careful']);

    const result = await runQuestionnaireRpc({ ui }, singleQuestion);

    expect(result.context).toBe('be careful');
  });

  test('leaves context null when skipped', async () => {
    const { ui } = fakeUi(['○ High']);

    const result = await runQuestionnaireRpc({ ui }, singleQuestion);

    expect(result.context).toBeNull();
  });
});
