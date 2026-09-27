import { describe, expect, test } from 'bun:test';

import {
  CARD_ANSWER_PREFIX,
  CARD_REQUEST_PREFIX,
  decodeCardAnswer,
  encodeCardRequest,
  type CardRequest,
} from './card.js';

const request: CardRequest = {
  title: 'Questions',
  questions: [
    {
      id: 'scope',
      label: 'Scope',
      prompt: 'What is the scope?',
      selectionMode: 'single',
      allowOther: true,
      options: [{ value: 'low', label: 'Low' }],
    },
  ],
};

describe('encodeCardRequest', () => {
  test('prefixes the JSON request', () => {
    expect(encodeCardRequest(request)).toBe(`${CARD_REQUEST_PREFIX}${JSON.stringify(request)}`);
  });
});

describe('decodeCardAnswer', () => {
  test('reads an answer the panel sends back', () => {
    const answer = {
      answers: [{ id: 'scope', values: ['low'], other: null }],
      context: null,
      cancelled: false,
    };

    expect(decodeCardAnswer(`${CARD_ANSWER_PREFIX}${JSON.stringify(answer)}`)).toEqual(answer);
  });

  test('returns undefined for an unrelated value', () => {
    expect(decodeCardAnswer('○ Low')).toBeUndefined();
  });

  test('returns undefined for a malformed answer', () => {
    expect(decodeCardAnswer(`${CARD_ANSWER_PREFIX}{not json`)).toBeUndefined();
    expect(decodeCardAnswer(`${CARD_ANSWER_PREFIX}{"answers":[]}`)).toBeUndefined();
  });
});
