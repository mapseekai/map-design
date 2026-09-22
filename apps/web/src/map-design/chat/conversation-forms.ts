import type { MapDesignMessage as Message } from '@mapseekai/contracts';
import { splitOnQuestionForms, type QuestionForm } from '../../runtime/question-form';

export type Answers = Record<string, string | string[]>;
type FormOccurrence = { key: string; messageIndex: number; form: QuestionForm };
type MessageFormOccurrence = Omit<FormOccurrence, 'messageIndex'>;
export type SubmittedForms = Readonly<Record<string, Answers>>;
const MAX_RETAINED_CONVERSATION_DRAFTS = 20;
export const EMPTY_SUBMITTED_FORMS: SubmittedForms = Object.freeze({});
const messageFormOccurrenceCache = new WeakMap<Message, readonly MessageFormOccurrence[]>();

function messageFormOccurrences(message: Message): readonly MessageFormOccurrence[] {
  if (message.role !== 'assistant') return [];
  const cached = messageFormOccurrenceCache.get(message);
  if (cached) return cached;
  const occurrences = splitOnQuestionForms(message.content).flatMap((segment, segmentIndex) =>
    segment.kind === 'form'
      ? [{ key: `${message.id}:${segmentIndex}`, form: segment.form }]
      : [],
  );
  messageFormOccurrenceCache.set(message, occurrences);
  return occurrences;
}

export function formOccurrences(messages: readonly Message[]): FormOccurrence[] {
  return messages.flatMap((message, messageIndex) =>
    messageFormOccurrences(message).map((occurrence) => ({ ...occurrence, messageIndex })),
  );
}

function answerValueEquals(left: string | string[], right: string | string[]): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function submittedFormsEqual(left: SubmittedForms, right: SubmittedForms): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => {
    const leftAnswers = left[key];
    const rightAnswers = right[key];
    if (!leftAnswers || !rightAnswers) return false;
    const answerKeys = Object.keys(leftAnswers);
    return answerKeys.length === Object.keys(rightAnswers).length && answerKeys.every((answerKey) => {
      const leftValue = leftAnswers[answerKey];
      const rightValue = rightAnswers[answerKey];
      return leftValue !== undefined && rightValue !== undefined && answerValueEquals(leftValue, rightValue);
    });
  });
}

export function latestUnansweredFormOccurrence(
  messages: readonly Message[],
  answered: Readonly<Record<string, Answers>>,
): FormOccurrence | undefined {
  return formOccurrences(messages).reverse().find((occurrence) => !answered[occurrence.key]);
}
