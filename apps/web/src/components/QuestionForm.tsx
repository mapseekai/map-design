import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Button, ColorInput, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, Textarea, Field, FieldGroup, FieldLabel, Badge, Switch, Slider, Tabs, TabsList, TabsTrigger, TabsContent, cn,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mapseekai/components';
import { tForLanguageTag, useT } from '../i18n';
import type { DirectionCard, FormOption, QuestionForm } from '../runtime/question-form';
import { formatFormAnswers, formOptionValueForLabel } from '../runtime/question-form';
import {
  visualStyleCardsForContext,
  type VisualStyleCard,
  type VisualStyleCategory,
  type VisualStyleContext,
  type VisualStyleVariant,
} from '../runtime/visual-style-catalog';
import { Check, RefreshCw, X } from 'lucide-react';

export type QuestionFormInteraction =
  | {
      element: 'visual_style_card';
      questionId: string;
      styleId: string;
      styleContext: VisualStyleContext;
      source: 'inline' | 'gallery';
    }
  | {
      element: 'visual_style_refresh' | 'visual_style_gallery_open';
      questionId: string;
      styleContext: VisualStyleContext;
    }
  | {
      element: 'visual_style_category_tab';
      questionId: string;
      styleContext: VisualStyleContext;
      categoryId: 'all' | 'business' | 'editorial' | 'creative' | 'minimal';
    }
  | {
      element: 'step_back' | 'step_next' | 'step_skip';
      questionId: string;
      stepIndex: number;
      stepCount: number;
    };

const OPTIONAL_FORM_AUTO_CONTINUE_SECONDS = 10 * 60;

interface Props {
  form: QuestionForm;
  // Whether the user can still submit answers. The owning AssistantMessage
  // disables the form when the assistant turn is no longer the most recent
  // one (i.e. the user has already moved past it).
  interactive: boolean;
  // Pre-existing answers — when we detect a follow-up user message that
  // begins with "[form answers — <id>]", we parse it back out and pass it
  // here so the rendered form reflects what was sent.
  submittedAnswers?: Record<string, string | string[]>;
  // Embedded hosts may own submission, so the form can hide its footer and
  // report draft/readiness state outward.
  hideInternalSubmit?: boolean;
  draftAnswers?: Record<string, string | string[]>;
  onReadyChange?: (ready: boolean) => void;
  onDraftChange?: (answers: Record<string, string | string[]>) => void;
  // Fires on each real user interaction with a single question (locked forms
  // never reach it), allowing the host to track finite-choice picks.
  onAnswerChange?: (questionId: string, value: string | string[]) => void;
  onInteraction?: (interaction: QuestionFormInteraction) => void;
  onSubmit?: (
    text: string,
    answers: Record<string, string | string[]>,
    source: 'submit' | 'skip' | 'auto',
    files?: QuestionFormFileSubmission[],
  ) => void;
  submitDisabled?: boolean;
  visualStyleContext?: VisualStyleContext;
  // When enabled, the form moves on after the timeout. Any unanswered field,
  // including a required one, is submitted as "(skipped)".
  autoContinueAfterTimeout?: boolean;
}

export interface QuestionFormFileSubmission {
  questionId: string;
  questionLabel: string;
  files: File[];
}

// Lets an embedding host trigger submission.
export interface QuestionFormHandle {
  submit: () => void;
  // Submit with no answers — backs the "skip all" affordance. This is an
  // explicit user decision, so it records every question as "(skipped)" and
  // moves on even when the normal form path marks a question required.
  skipAll: () => void;
}

export const QuestionFormView = forwardRef<QuestionFormHandle, Props>(function QuestionFormView(
  {
    form,
    interactive,
    submittedAnswers,
    hideInternalSubmit = false,
    draftAnswers,
    onReadyChange,
    onDraftChange,
    onAnswerChange,
    onInteraction,
    onSubmit,
    submitDisabled = false,
    visualStyleContext,
    autoContinueAfterTimeout = false,
  },
  ref,
) {
  const uiT = useT();
  // Host strings inside the card follow the form's declared content language
  // (`form.lang`, set by the model alongside the localized labels) so a
  // Chinese form in an English UI doesn't mix scripts; without a resolvable
  // tag they follow the app UI locale as before.
  const t = useMemo(() => tForLanguageTag(form.lang) ?? uiT, [form.lang, uiT]);
  const initial = useMemo(
    () => buildInitialState(form, submittedAnswers, draftAnswers, visualStyleContext),
    [form, submittedAnswers, draftAnswers, visualStyleContext],
  );
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(initial);
  const [fileAnswers, setFileAnswers] = useState<Record<string, File[]>>({});
  // Question ids the user has interacted with this mount, seeded with ids
  // restored from a submitted/draft snapshot (those are prior user input).
  // "Untouched" for the streamed-default backfill below means absent here —
  // NOT "currently empty": clearing an answer is itself a touch.
  const [touched] = useState(
    () => new Set<string>(Object.keys(submittedAnswers ?? draftAnswers ?? {})),
  );
  // Finite-choice questions keep their type-in field collapsed behind a
  // host-rendered "Other" chip; this tracks which questions the user expanded
  // this mount. A question whose current answer already carries a custom
  // value (submitted history, restored draft) renders expanded without an
  // entry here — see customChoiceExpanded.
  const [otherOpen, setOtherOpen] = useState<Set<string>>(() => new Set());
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [skippedQuestionIds, setSkippedQuestionIds] = useState<Set<string>>(() => new Set());
  const [autoContinueRemaining, setAutoContinueRemaining] = useState(
    OPTIONAL_FORM_AUTO_CONTINUE_SECONDS,
  );
  const autoContinuedRef = useRef(false);
  const locked = !interactive || !onSubmit || submittedAnswers !== undefined;
  // Submitted answers are held by the host in their original wire format.
  // Use the normalized snapshot for rendering so legacy tone values select
  // the same visual card that a new submission will send.
  const currentAnswers = submittedAnswers !== undefined ? initial : answers;
  const stepped = !locked && !hideInternalSubmit && form.questions.length > 1;
  const activeQuestion = form.questions[activeQuestionIndex];
  const isLastQuestion = activeQuestionIndex === form.questions.length - 1;
  const questionsToRender = stepped && activeQuestion ? [activeQuestion] : form.questions;

  useEffect(() => {
    setActiveQuestionIndex(0);
    setSkippedQuestionIds(new Set());
  }, [form.id]);

  useEffect(() => {
    setActiveQuestionIndex((current) =>
      Math.min(current, Math.max(0, form.questions.length - 1)),
    );
  }, [form.questions.length]);

  function hasCustomAnswer(q: QuestionForm['questions'][number]): boolean {
    const value = currentAnswers[q.id];
    return q.type === 'checkbox'
      ? customCheckboxValue(q, value).length > 0
      : customSingleValue(q, value).length > 0;
  }

  // Whether a finite-choice question shows its custom type-in field. Locked
  // forms only ever show it when the recorded answer is a custom value.
  function customChoiceExpanded(q: QuestionForm['questions'][number]): boolean {
    if (locked) return hasCustomAnswer(q);
    return otherOpen.has(q.id) || hasCustomAnswer(q);
  }

  // Toggle the "Other" chip. Opening a single-choice question's field
  // deselects the fixed options (the user is saying "none of these");
  // collapsing discards any custom text and keeps only known option values.
  function toggleOther(q: QuestionForm['questions'][number]) {
    if (locked) return;
    const expanded = customChoiceExpanded(q);
    setOtherOpen((prev) => {
      const next = new Set(prev);
      if (expanded) next.delete(q.id);
      else next.add(q.id);
      return next;
    });
    if (expanded) {
      if (q.type === 'checkbox') {
        const current = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
        update(q.id, current.filter((entry) => questionValueIsKnown(q, entry)));
      } else {
        const current = typeof answers[q.id] === 'string' ? (answers[q.id] as string) : '';
        if (!questionValueIsKnown(q, current)) update(q.id, '');
      }
    } else if (q.type !== 'checkbox') {
      update(q.id, '');
    }
  }

  // Picking a fixed option collapses an open (and still empty) "Other" field
  // on single-choice questions; checkbox questions keep it open since fixed
  // and custom entries coexist.
  function pickFixed(q: QuestionForm['questions'][number], value: string) {
    setOtherOpen((prev) => {
      if (!prev.has(q.id)) return prev;
      const next = new Set(prev);
      next.delete(q.id);
      return next;
    });
    update(q.id, value);
  }

  function renderOtherChip(q: QuestionForm['questions'][number]) {
    const on = customChoiceExpanded(q);
    // A real <Button variant={on ? "secondary" : "outline"}> keeps the escape hatch in the tab order — the previous
    // display:none checkbox inside a label was mouse-only for keyboard and
    // screen-reader users.
    return (
      <Button variant={on ? "secondary" : "outline"}
        type="button"
        className="h-auto whitespace-normal text-left"
        aria-pressed={on}
        aria-expanded={on}
        disabled={locked}
        onClick={() => toggleOther(q)}
      >
        <span className="flex flex-col gap-1">
          <span>{t('questionForm.otherOption')}</span>
        </span>
      </Button>
    );
  }

  useEffect(() => {
    setFileAnswers({});
  }, [form.id]);

  // When the form streams in question-by-question, backfill state for newly
  // revealed questions without disturbing answers the user already touched.
  useEffect(() => {
    setAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of form.questions) {
        if (next[q.id] !== undefined) {
          if (shouldAdoptStreamedDefault(q, next[q.id]!, touched)) {
            next[q.id] = canonicalizeQuestionValue(
              q,
              q.defaultValue!,
              visualStyleContext,
            );
            changed = true;
          }
          continue;
        }
        changed = true;
        if (submittedAnswers && submittedAnswers[q.id] !== undefined) {
          next[q.id] = canonicalizeQuestionValue(
            q,
            submittedAnswers[q.id]!,
            visualStyleContext,
          );
        } else if (q.defaultValue !== undefined) {
          next[q.id] = canonicalizeQuestionValue(q, q.defaultValue, visualStyleContext);
        } else {
          next[q.id] = emptyQuestionValue(q);
        }
      }
      return changed ? next : prev;
    });
  }, [form, submittedAnswers, touched, visualStyleContext]);

  function update(id: string, value: string | string[]) {
    if (locked) return;
    touched.add(id);
    const next = { ...answers, [id]: value };
    setAnswers(next);
    setSkippedQuestionIds((current) => {
      if (!current.has(id)) return current;
      const nextSkipped = new Set(current);
      nextSkipped.delete(id);
      return nextSkipped;
    });
    onDraftChange?.(draftSafeAnswers(form, next));
    onAnswerChange?.(id, value);
  }

  function toggleCheckbox(id: string, option: string, maxSelections?: number) {
    if (locked) return;
    const current = Array.isArray(answers[id]) ? (answers[id] as string[]) : [];
    const has = current.includes(option);
    if (!has && maxSelections !== undefined && current.length >= maxSelections) return;
    touched.add(id);
    const next = has ? current.filter((v) => v !== option) : [...current, option];
    const nextAnswers = { ...answers, [id]: next };
    setAnswers(nextAnswers);
    setSkippedQuestionIds((currentSkipped) => {
      if (!currentSkipped.has(id)) return currentSkipped;
      const nextSkipped = new Set(currentSkipped);
      nextSkipped.delete(id);
      return nextSkipped;
    });
    onDraftChange?.(draftSafeAnswers(form, nextAnswers));
    onAnswerChange?.(id, next);
  }

  function updateCheckboxCustom(q: QuestionForm['questions'][number], raw: string) {
    if (locked) return;
    const current = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
    const fixed = current.filter((entry) => questionValueIsKnown(q, entry));
    update(q.id, [...fixed, ...splitCustomEntries(raw)]);
  }

  function finalizeSubmission(
    source: 'submit' | 'skip' | 'auto',
    skippedIds: ReadonlySet<string> = skippedQuestionIds,
  ) {
    if (!onSubmit) return;
    const submittedAnswers = answersWithSkippedQuestions(form, answers, skippedIds);
    const submissionForm = formWithVisualStyleOptions(form, visualStyleContext);
    const files = collectFileSubmissions(form, fileAnswers, skippedIds);
    if (files.length > 0) {
      onSubmit(formatFormAnswers(submissionForm, submittedAnswers), submittedAnswers, source, files);
    } else {
      onSubmit(formatFormAnswers(submissionForm, submittedAnswers), submittedAnswers, source);
    }
  }

  function handleSubmit() {
    if (locked || !onSubmit) return;
    // Block submit until required fields are answered and selection caps hold.
    if (!ready) return;
    finalizeSubmission('submit');
  }

  function handleSkipAll() {
    if (locked || !onSubmit) return;
    const empty: Record<string, string | string[]> = {};
    onSubmit(formatFormAnswers(formWithVisualStyleOptions(form, visualStyleContext), empty), empty, 'skip');
  }

  function handleSkipCurrent() {
    if (locked || !onSubmit || !activeQuestion) return;
    onInteraction?.({
      element: 'step_skip',
      questionId: activeQuestion.id,
      stepIndex: activeQuestionIndex + 1,
      stepCount: form.questions.length,
    });
    const nextSkipped = new Set(skippedQuestionIds);
    nextSkipped.add(activeQuestion.id);
    setSkippedQuestionIds(nextSkipped);
    if (!isLastQuestion) {
      setActiveQuestionIndex((current) => current + 1);
      return;
    }
    finalizeSubmission('skip', nextSkipped);
  }

  function handlePreviousQuestion() {
    if (!activeQuestion || activeQuestionIndex === 0) return;
    onInteraction?.({
      element: 'step_back',
      questionId: activeQuestion.id,
      stepIndex: activeQuestionIndex + 1,
      stepCount: form.questions.length,
    });
    setActiveQuestionIndex((current) => Math.max(0, current - 1));
  }

  function handleNextQuestion() {
    if (!activeQuestion || isLastQuestion || !currentQuestionReady) return;
    onInteraction?.({
      element: 'step_next',
      questionId: activeQuestion.id,
      stepIndex: activeQuestionIndex + 1,
      stepCount: form.questions.length,
    });
    setActiveQuestionIndex((current) => current + 1);
  }

  // Per-question checkbox selection caps must hold.
  const withinSelectionLimits = form.questions.every((q) => {
    if (q.type !== 'checkbox' || q.maxSelections === undefined) return true;
    const v = currentAnswers[q.id];
    return !Array.isArray(v) || v.length <= q.maxSelections;
  });
  // Required questions must carry a non-empty answer on the normal path. An
  // explicit per-question Skip is a deliberate alternative: it serializes the
  // value as "(skipped)" and lets the agent proceed with sensible defaults.
  const requiredAnswered = form.questions.every((q) => {
    if (q.required !== true) return true;
    if (skippedQuestionIds.has(q.id)) return true;
    const v = currentAnswers[q.id];
    return questionAnswerIsPresent(v);
  });
  const ready = withinSelectionLimits && requiredAnswered;
  // A manual Skip all is always available, including for required questions.
  const canSkipAll = true;
  const hasRequiredQuestions = form.questions.some((q) => q.required === true);
  // Timeout continuation shares the explicit Skip semantics: unanswered
  // questions, including required ones, are serialized as "(skipped)".
  const autoContinueEnabled =
    autoContinueAfterTimeout &&
    !locked &&
    !submitDisabled;
  const currentQuestionReady =
    !activeQuestion ||
    activeQuestion.required !== true ||
    skippedQuestionIds.has(activeQuestion.id) ||
    questionAnswerIsPresent(currentAnswers[activeQuestion.id]);
  const autoContinueCountdown = `${Math.floor(autoContinueRemaining / 60)}:${String(
    autoContinueRemaining % 60,
  ).padStart(2, '0')}`;

  useImperativeHandle(ref, () => ({ submit: handleSubmit, skipAll: handleSkipAll }));
  useEffect(() => {
    onReadyChange?.(!locked && ready);
  }, [onReadyChange, locked, ready]);
  useEffect(() => {
    if (!autoContinueEnabled) {
      setAutoContinueRemaining(OPTIONAL_FORM_AUTO_CONTINUE_SECONDS);
      autoContinuedRef.current = false;
      return;
    }
    setAutoContinueRemaining(OPTIONAL_FORM_AUTO_CONTINUE_SECONDS);
    autoContinuedRef.current = false;
    const timer = window.setInterval(() => {
      setAutoContinueRemaining((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoContinueEnabled, form.id]);
  useEffect(() => {
    if (
      !autoContinueEnabled ||
      autoContinueRemaining > 0 ||
      autoContinuedRef.current ||
      !onSubmit
    ) {
      return;
    }
    autoContinuedRef.current = true;
    finalizeSubmission('auto');
  }, [answers, autoContinueEnabled, autoContinueRemaining, fileAnswers, form, onSubmit]);

  return (
    <div className={cn('flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-card p-5 text-card-foreground', locked ? 'opacity-80' : '')} data-form-id={form.id}>
      <div data-ui="question-form-head" className="flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground" aria-hidden>?</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="font-medium">{form.title}</div>
          {form.description ? (
            <div className="text-sm text-muted-foreground">{form.description}</div>
          ) : null}
        </div>
        {stepped ? (
          <span
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
            aria-label={`${activeQuestionIndex + 1} / ${form.questions.length}`}
          >
            {activeQuestionIndex + 1} / {form.questions.length}
          </span>
        ) : null}
        {locked ? <Badge variant="secondary">{t('questionForm.answered')}</Badge> : null}
      </div>
      <FieldGroup>
        {questionsToRender.map((q) => {
          const value = currentAnswers[q.id];
          const visualStyleCards =
            visualStyleContext &&
            q.id === 'tone' &&
            (q.type === 'checkbox' || q.type === 'radio') &&
            q.options
              ? visualStyleCardsForContext(visualStyleContext)
              : null;
          return (
            <Field
              key={q.id}
              data-ui="qf-field" className={cn('min-w-0', visualStyleCards ? 'w-full' : '')}
            >
              <FieldLabel>
                <span>{q.label}</span>
                {q.required ? <span data-ui="qf-required" className="text-xs text-muted-foreground">{t('questionForm.required')}</span> : null}
              </FieldLabel>
              {q.help ? <div className="text-sm text-muted-foreground">{q.help}</div> : null}
              {q.type === 'radio' && q.options && !visualStyleCards ? (
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt) => (
                    <label
                      key={opt.value}
                      className={cn('flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', value === opt.value ? 'border-primary bg-accent text-accent-foreground' : '')}
                      title={opt.description}
                    >
                      <Input className="size-4 shrink-0"
                        type="radio"
                        name={`${form.id}-${q.id}`}
                        value={opt.value}
                        checked={value === opt.value}
                        disabled={locked}
                        aria-label={opt.label}
                        onChange={() => pickFixed(q, opt.value)}
                      />
                      <OptionCopy option={opt} />
                    </label>
                  ))}
                  {shouldRenderCustomChoice(q) ? renderOtherChip(q) : null}
                </div>
              ) : null}
              {q.type === 'radio' &&
              q.options &&
              !visualStyleCards &&
              shouldRenderCustomChoice(q) ? (
                <CollapsibleCustomChoice open={customChoiceExpanded(q)}>
                  <CustomChoiceInput
                    label={q.customLabel ?? t('questionForm.customLabel')}
                    value={customSingleValue(q, value)}
                    placeholder={q.customPlaceholder ?? t('questionForm.customPlaceholder')}
                    disabled={locked || !customChoiceExpanded(q)}
                    onChange={(next) => update(q.id, next)}
                  />
                </CollapsibleCustomChoice>
              ) : null}
              {q.type === 'checkbox' && q.options && !visualStyleCards ? (
                <div className="flex flex-wrap gap-2">
                  {q.options.map((opt) => {
                    const arr = Array.isArray(value) ? value : [];
                    const on = arr.includes(opt.value);
                    const maxed =
                      q.maxSelections !== undefined && !on && arr.length >= q.maxSelections;
                    return (
                      <label
                        key={opt.value}
                        title={opt.description}
                        className={cn('flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', on ? 'border-primary bg-accent text-accent-foreground' : '', maxed ? 'cursor-not-allowed opacity-50' : '')}
                      >
                        <Input className="size-4 shrink-0"
                          type="checkbox"
                          value={opt.value}
                          checked={on}
                          disabled={locked || maxed}
                          aria-label={opt.label}
                          onChange={() => toggleCheckbox(q.id, opt.value, q.maxSelections)}
                        />
                        <OptionCopy option={opt} />
                      </label>
                    );
                  })}
                  {shouldRenderCustomChoice(q) ? renderOtherChip(q) : null}
                </div>
              ) : null}
              {visualStyleCards && visualStyleContext ? (
                <VisualStylePicker
                  cards={visualStyleCards}
                  context={visualStyleContext}
                  formId={form.id}
                  questionId={q.id}
                  title={q.label}
                  allowCustom={shouldRenderCustomChoice(q)}
                  customLabel={q.customLabel ?? t('questionForm.customLabel')}
                  customPlaceholder={q.customPlaceholder ?? t('questionForm.customPlaceholder')}
                  value={
                    Array.isArray(value)
                      ? value
                      : typeof value === 'string' && value
                        ? [value]
                        : []
                  }
                  disabled={locked}
                  selectionMode={q.type === 'radio' ? 'single' : 'multiple'}
                  maxSelections={q.type === 'checkbox' ? q.maxSelections : 1}
                  onChange={(next) =>
                    update(q.id, q.type === 'radio' ? (next[0] ?? '') : next)
                  }
                  onInteraction={onInteraction}
                />
              ) : null}
              {q.type === 'checkbox' &&
              q.options &&
              !visualStyleCards &&
              shouldRenderCustomChoice(q) ? (
                <CollapsibleCustomChoice open={customChoiceExpanded(q)}>
                  <CustomChoiceInput
                    label={q.customLabel ?? t('questionForm.customLabel')}
                    value={customCheckboxValue(q, value)}
                    placeholder={q.customPlaceholder ?? t('questionForm.customPlaceholder')}
                    disabled={locked || !customChoiceExpanded(q)}
                    onChange={(next) => updateCheckboxCustom(q, next)}
                  />
                </CollapsibleCustomChoice>
              ) : null}
              {q.type === 'select' && q.options ? (
                <Select
                  items={[{ value: null, label: q.placeholder ?? t('questionForm.choose') }, ...q.options.map((opt) => ({ value: opt.value || '__map-design-empty__', label: opt.label })), ...(shouldRenderCustomChoice(q) ? [{ value: OTHER_SELECT_VALUE, label: `${t('questionForm.otherOption')}…` }] : [])]}
                  value={typeof value === 'string' && value.length > 0 && questionValueIsKnown(q, value) ? value : customChoiceExpanded(q) ? OTHER_SELECT_VALUE : null}
                  disabled={locked}
                  onValueChange={(nextValue) => {
                    if (nextValue === null) return;
                    if (nextValue === OTHER_SELECT_VALUE) {
                      if (!customChoiceExpanded(q)) toggleOther(q);
                      return;
                    }
                    pickFixed(q, nextValue === '__map-design-empty__' ? '' : nextValue);
                  }}
                >
                  <SelectTrigger aria-label={q.label}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>
                    {q.options.map((opt) => <SelectItem key={opt.value} data-value={opt.value || '__map-design-empty__'} value={opt.value || '__map-design-empty__'} title={opt.description}>{opt.label}</SelectItem>)}
                    {shouldRenderCustomChoice(q) ? <SelectItem data-value={OTHER_SELECT_VALUE} value={OTHER_SELECT_VALUE}>{t('questionForm.otherOption')}…</SelectItem> : null}
                  </SelectGroup></SelectContent>
                </Select>
              ) : null}
              {q.type === 'select' && q.options && shouldRenderCustomChoice(q) ? (
                <CollapsibleCustomChoice open={customChoiceExpanded(q)}>
                  <CustomChoiceInput
                    label={q.customLabel ?? t('questionForm.customLabel')}
                    value={customSingleValue(q, value)}
                    placeholder={q.customPlaceholder ?? t('questionForm.customPlaceholder')}
                    disabled={locked || !customChoiceExpanded(q)}
                    onChange={(next) => update(q.id, next)}
                  />
                </CollapsibleCustomChoice>
              ) : null}
              {q.type === 'text' ? (
                <Input aria-label={q.label}
                  type="text"
                  className="w-full"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'number' ? (
                <Input aria-label={q.label}
                  type="number"
                  className="w-full"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  min={q.min}
                  max={q.max}
                  step={q.step}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'range' ? (
                <div className="flex items-center gap-3">
                  <Slider aria-label={q.label} value={Number(typeof value === 'string' && value.trim() ? value : q.min ?? 0)} min={q.min} max={q.max} step={q.step} disabled={locked} onValueChange={(next) => update(q.id, String(Array.isArray(next) ? next[0] ?? q.min ?? 0 : next))} />
                  <output className="min-w-8 text-right text-sm tabular-nums">
                    {typeof value === 'string' && value.trim() ? value : String(q.min ?? 0)}
                  </output>
                </div>
              ) : null}
              {q.type === 'date' || q.type === 'time' || q.type === 'datetime-local' ? (
                <Input aria-label={q.label}
                  type={q.type}
                  className="w-full"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'color' ? (
                <ColorInput aria-label={q.label}
                  swatchLabel={q.label}
                  value={typeof value === 'string' ? value : '#000000'}
                  disabled={locked}
                  onTextChange={(nextValue) => update(q.id, nextValue)}
                />
              ) : null}
              {q.type === 'url' || q.type === 'email' || q.type === 'tel' ? (
                <Input aria-label={q.label}
                  type={q.type}
                  className="w-full"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'file' ? (
                <div className="flex flex-col gap-2">
                  <Input aria-label={q.label}
                    type="file"
                    className="w-full"
                    multiple={q.multiple}
                    accept={q.accept}
                    disabled={locked}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      const names = files.map((file) => file.name);
                      setFileAnswers((current) => ({ ...current, [q.id]: files }));
                      update(q.id, q.multiple ? names : names[0] ?? '');
                    }}
                  />
                  {fileValueLabel(value) ? (
                    <div className="break-words text-xs text-muted-foreground">{fileValueLabel(value)}</div>
                  ) : null}
                </div>
              ) : null}
              {q.type === 'switch' ? <Switch aria-label={q.label} checked={value === 'true'} disabled={locked} onCheckedChange={(checked) => update(q.id, checked ? 'true' : 'false')} /> : null}
              {q.type === 'textarea' ? (
                <Textarea aria-label={q.label}
                  className="w-full"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  rows={3}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'direction-cards' && q.cards && q.cards.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {q.cards.map((card) => (
                    <DirectionCardView
                      key={card.id}
                      card={card}
                      formId={form.id}
                      questionId={q.id}
                      selected={value === card.id || value === card.label}
                      disabled={locked}
                      onSelect={() => pickFixed(q, card.id)}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}
              {q.type === 'direction-cards' && q.cards && q.cards.length > 0 && shouldRenderCustomChoice(q) ? (
                <>
                  <div className="flex flex-wrap gap-2">{renderOtherChip(q)}</div>
                  <CollapsibleCustomChoice open={customChoiceExpanded(q)}>
                    <CustomChoiceInput
                      label={q.customLabel ?? t('questionForm.customLabel')}
                      value={customSingleValue(q, value)}
                      placeholder={q.customPlaceholder ?? t('questionForm.customPlaceholder')}
                      disabled={locked || !customChoiceExpanded(q)}
                      onChange={(next) => update(q.id, next)}
                    />
                  </CollapsibleCustomChoice>
                </>
              ) : null}
            </Field>
          );
        })}
      </FieldGroup>
      {hideInternalSubmit ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          {locked ? (
            <span className="text-xs text-muted-foreground">
              {submittedAnswers ? t('questionForm.lockedSubmitted') : t('questionForm.lockedPrev')}
            </span>
          ) : stepped ? (
            <>
              {autoContinueEnabled ? (
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  title={t('questionForm.autoSkipHint')}
                  aria-label={`${t('questionForm.autoSkipHint')} ${autoContinueCountdown}`}
                >
                  {autoContinueCountdown}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                onClick={handleSkipCurrent}
                disabled={submitDisabled}
              >
                {t('questionForm.skip')}
              </Button>
              <span className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handlePreviousQuestion}
                  disabled={submitDisabled || activeQuestionIndex === 0}
                >
                  {t('questionForm.back')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  onClick={
                    isLastQuestion
                      ? handleSubmit
                      : handleNextQuestion
                  }
                  disabled={
                    submitDisabled || (isLastQuestion ? !ready : !currentQuestionReady)
                  }
                  title={
                    !submitDisabled && activeQuestion?.required === true && !currentQuestionReady
                      ? t('questionForm.submitDisabledTitle')
                      : isLastQuestion && !submitDisabled && ready
                        ? t('questionForm.submitTitle')
                        : undefined
                  }
                >
                  {isLastQuestion
                    ? form.submitLabel ?? t('questionForm.submitDefault')
                    : t('questionForm.next')}
                </Button>
              </span>
            </>
          ) : autoContinueEnabled || !hasRequiredQuestions ? (
            <span
              className="text-xs tabular-nums text-muted-foreground"
              title={autoContinueEnabled ? t('questionForm.autoSkipHint') : undefined}
              aria-label={
                autoContinueEnabled
                  ? `${t('questionForm.autoSkipHint')} ${autoContinueCountdown}`
                  : undefined
              }
            >
              {autoContinueEnabled ? autoContinueCountdown : t('questionForm.hint')}
            </span>
          ) : null}
          {!locked && !stepped ? (
            <span className="flex flex-wrap items-center gap-2">
              {canSkipAll ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleSkipAll}
                  disabled={submitDisabled}
                >
                  {t('questionForm.skipAll')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="default"
                onClick={handleSubmit}
                disabled={submitDisabled || !ready}
                title={!submitDisabled && ready ? t('questionForm.submitTitle') : t('questionForm.submitDisabledTitle')}
              >
                {form.submitLabel ?? t('questionForm.submitDefault')}
              </Button>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
});

function OptionCopy({ option }: { option: FormOption }) {
  return (
    <span className="flex flex-col gap-1">
      <span>{option.label}</span>
      {option.description ? <span className="text-xs text-muted-foreground">{option.description}</span> : null}
    </span>
  );
}

// Sentinel value for the host-injected "Other…" entry in a select control.
// Never leaks into answers: choosing it only expands the type-in field.
const OTHER_SELECT_VALUE = '__map-design-other__';

// Accordion wrapper for the custom type-in field: stays mounted so the
// collapse transition can play (see AGENTS.md → UI animation philosophy).
function CollapsibleCustomChoice({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div data-ui="qf-custom-collapsible" data-state={open ? 'open' : 'closed'} className={cn('grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function CustomChoiceInput({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const chars = customInputCharCount(value, placeholder);
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span>{label}</span>
      <Input
        type="text"
        className="w-full"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        style={{ width: `${chars}ch`, maxWidth: '100%' } as CSSProperties}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

const VISUAL_STYLE_PAGE_SIZE = 4;
type VisualStyleGalleryCategory = 'all' | VisualStyleCategory;
const VISUAL_STYLE_GALLERY_CATEGORIES: Array<{
  value: VisualStyleGalleryCategory;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'business', label: 'Business' },
  { value: 'editorial', label: 'Editorial' },
  { value: 'creative', label: 'Creative' },
  { value: 'minimal', label: 'Minimal' },
];

function VisualStylePicker({
  cards,
  context,
  formId,
  questionId,
  title,
  allowCustom,
  customLabel,
  customPlaceholder,
  value,
  disabled,
  selectionMode,
  maxSelections,
  onChange,
  onInteraction,
}: {
  cards: VisualStyleCard[];
  context: VisualStyleContext;
  formId: string;
  questionId: string;
  title: string;
  allowCustom: boolean;
  customLabel: string;
  customPlaceholder: string;
  value: string[];
  disabled: boolean;
  selectionMode: 'single' | 'multiple';
  maxSelections?: number;
  onChange: (value: string[]) => void;
  onInteraction?: (interaction: QuestionFormInteraction) => void;
}) {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryCategory, setGalleryCategory] =
    useState<VisualStyleGalleryCategory>('all');
  const selectedCards = cards.filter((card) => value.includes(card.value));
  const customValue =
    value.find((candidate) => !cards.some((card) => card.value === candidate)) ?? '';
  const page = Array.from(
    { length: Math.min(VISUAL_STYLE_PAGE_SIZE, cards.length) },
    (_, index) => {
      const cardIndex = (offset + index) % cards.length;
      return cards[cardIndex]!;
    },
  );
  const compactSelectedCards = selectedCards.slice(
    0,
    Math.max(VISUAL_STYLE_PAGE_SIZE, selectedCards.length),
  );
  const compactCards =
    compactSelectedCards.length > 0
      ? [
          ...compactSelectedCards,
          ...page.filter((card) => !value.includes(card.value)),
        ].slice(0, Math.max(VISUAL_STYLE_PAGE_SIZE, compactSelectedCards.length))
      : page;
  const remaining = Math.max(0, cards.length - compactCards.length);
  const galleryCards =
    galleryCategory === 'all'
      ? cards
      : cards.filter((card) => card.category === galleryCategory);

  function shuffle() {
    if (cards.length <= VISUAL_STYLE_PAGE_SIZE) return;
    onInteraction?.({
      element: 'visual_style_refresh',
      questionId,
      styleContext: context,
    });
    setOffset((current) => (current + VISUAL_STYLE_PAGE_SIZE) % cards.length);
  }

  function selectStyle(card: VisualStyleCard, source: 'inline' | 'gallery') {
    onInteraction?.({
      element: 'visual_style_card',
      questionId,
      styleId: card.value,
      styleContext: context,
      source,
    });
    if (selectionMode === 'single') {
      onChange([card.value]);
      return;
    }
    if (value.includes(card.value)) {
      onChange(value.filter((candidate) => candidate !== card.value));
      return;
    }
    if (maxSelections !== undefined && value.length >= maxSelections) return;
    onChange([...value, card.value]);
  }

  return (
    <>
      <div className="flex flex-col gap-3" data-artifact-type={context}>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || cards.length <= VISUAL_STYLE_PAGE_SIZE}
            onClick={shuffle}
            title={t('chat.designFiles.refresh')}
            aria-label={t('chat.designFiles.refresh')}
          >
            <RefreshCw data-icon="inline-start" />
          </Button>
        </div>
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${compactCards.length + (remaining > 0 ? 1 : 0)}, minmax(0, 1fr))`,
          }}
        >
          {compactCards.map((card) => (
            <VisualStyleCardView
              key={card.value}
              card={card}
              context={context}
              formId={formId}
              questionId={questionId}
              selected={value.includes(card.value)}
              disabled={
                disabled ||
                (selectionMode === 'multiple' &&
                  !value.includes(card.value) &&
                  maxSelections !== undefined &&
                  value.length >= maxSelections)
              }
              inputType={selectionMode === 'single' ? 'radio' : 'checkbox'}
              onSelect={() => selectStyle(card, 'inline')}
            />
          ))}
          {remaining > 0 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-full min-h-24"
              disabled={disabled}
              aria-label={t('mapDesign.recent.viewAll')}
              onClick={() => {
                onInteraction?.({
                  element: 'visual_style_gallery_open',
                  questionId,
                  styleContext: context,
                });
                setGalleryOpen(true);
              }}
            >
              +{remaining}
            </Button>
          ) : null}
        </div>
        {customValue ? (
          <Button
            type="button"
            variant="ghost"
            data-ui="qf-visual-custom-summary" className="h-auto justify-start whitespace-normal"
            disabled={disabled}
            onClick={() => setGalleryOpen(true)}
          >
            <Check data-icon="inline-start" />
            <span>{customValue}</span>
          </Button>
        ) : null}
      </div>
      {galleryOpen
        ? createPortal(
            <Dialog
              className="w-[min(960px,calc(100vw-32px))] max-w-none"
              layout="sectioned"
              ariaLabel={title}
              onClose={() => setGalleryOpen(false)}
              closeOnEscape
            >
              <DialogHeader className="flex-row items-center justify-between">
                <DialogTitle className="">{title}</DialogTitle>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  onClick={() => setGalleryOpen(false)}
                >
                  <X data-icon="inline-start" />
                </Button>
              </DialogHeader>
              <DialogBody className="overflow-auto"><div className="flex flex-col gap-4">
                <Tabs value={galleryCategory} onValueChange={(value) => { if (typeof value === "string") setGalleryCategory(value as typeof galleryCategory); }}><TabsList
                  className="h-auto flex-wrap"
                  aria-label={`${title} categories`}
                >
                  {VISUAL_STYLE_GALLERY_CATEGORIES.map((category) => {

                    return (
                      <TabsTrigger
                        key={category.value}
                        value={category.value}
                        onClick={() => {
                          onInteraction?.({
                            element: 'visual_style_category_tab',
                            questionId,
                            styleContext: context,
                            categoryId: category.value,
                          });
                          setGalleryCategory(category.value);
                        }}
                      >
                        {category.label}
                      </TabsTrigger>
                    );
                  })}
                </TabsList><TabsContent value={galleryCategory}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {galleryCards.map((card) => (
                    <VisualStyleCardView
                      key={card.value}
                      card={card}
                      context={context}
                      formId={`${formId}-gallery`}
                      questionId={questionId}
                      selected={value.includes(card.value)}
                      disabled={
                        disabled ||
                        (selectionMode === 'multiple' &&
                          !value.includes(card.value) &&
                          maxSelections !== undefined &&
                          value.length >= maxSelections)
                      }
                      inputType={selectionMode === 'single' ? 'radio' : 'checkbox'}
                      onSelect={() => selectStyle(card, 'gallery')}
                    />
                  ))}
                </div></TabsContent></Tabs>
                {allowCustom ? (
                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium">{customLabel}</span>
                    <Input
                      type="text"
                      className="w-full"
                      value={customValue}
                      placeholder={customPlaceholder}
                      disabled={
                        disabled ||
                        (selectionMode === 'multiple' &&
                          !customValue &&
                          maxSelections !== undefined &&
                          value.length >= maxSelections)
                      }
                      onChange={(event) => {
                        const presets = value.filter((candidate) =>
                          cards.some((card) => card.value === candidate),
                        );
                        const nextCustom = event.target.value;
                        onChange(
                          nextCustom
                            ? selectionMode === 'single'
                              ? [nextCustom]
                              : [...presets, nextCustom]
                            : presets,
                        );
                      }}
                    />
                  </label>
                ) : null}
              </div></DialogBody>
              <DialogFooter className="">
                <Button type="button" variant="default" onClick={() => setGalleryOpen(false)}>
                  {t('common.done')}
                </Button>
              </DialogFooter>
            </Dialog>,
            document.body,
          )
        : null}
    </>
  );
}

function VisualStyleCardView({
  card,
  context,
  formId,
  questionId,
  selected,
  disabled,
  inputType,
  onSelect,
}: {
  card: VisualStyleCard;
  context: VisualStyleContext;
  formId: string;
  questionId: string;
  selected: boolean;
  disabled: boolean;
  inputType: 'radio' | 'checkbox';
  onSelect: () => void;
}) {
  return (
    <label
      data-ui="qf-visual-card" className={cn('relative flex min-w-0 cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', selected ? 'border-primary bg-accent' : '', card.recommended ? '' : '', disabled ? 'cursor-not-allowed opacity-50' : '')}
      data-recommended={card.recommended ? 'true' : undefined}
      title={card.title}
    >
      <Input className="sr-only"
        type={inputType}
        name={`${formId}-${questionId}`}
        value={card.value}
        checked={selected}
        disabled={disabled}
        aria-label={card.title}
        onChange={onSelect}
      />
      <VisualStylePreview context={context} variant={card.variant} preview={card.preview} />
      {selected ? (
        <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden>
          <Check data-icon="inline-start" />
        </span>
      ) : null}
      <span className="truncate text-xs font-medium">{card.title}</span>
    </label>
  );
}

function VisualStylePreview({
  context,
  variant,
  preview,
}: {
  context: VisualStyleContext;
  variant: VisualStyleCard['variant'];
  preview?: VisualStyleCard['preview'];
}) {
  if (preview) {
    return (
      <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-muted" data-style={variant}>
        <img className="size-full object-cover" src={preview.src} alt={preview.alt} loading="lazy" />
      </span>
    );
  }
  if (context === 'deck') {
    return (
      <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-muted grid grid-cols-3 gap-1 p-2" data-style={variant} aria-hidden>
        <span className="relative flex flex-col gap-1 rounded-sm bg-card p-1 justify-center">
          <span className="h-1 w-1/3 bg-primary" />
          <span className="h-1.5 w-full bg-foreground/70" />
          <span className="h-1.5 w-full bg-foreground/70 w-2/3" />
          <span className="mt-1 size-5 rounded-full bg-primary" />
        </span>
        <span className="relative flex flex-col gap-1 rounded-sm bg-card p-1 justify-center">
          <span className="flex flex-col gap-1 [&_i]:h-1 [&_i]:bg-muted-foreground/30">
            <i />
            <i />
            <i />
          </span>
          <span className="mt-1 h-6 rounded-sm bg-accent" />
        </span>
        <span className="relative flex flex-col gap-1 rounded-sm bg-card p-1 justify-end">
          <span className="flex h-12 items-end gap-1 [&_i]:flex-1 [&_i]:bg-primary [&_i:nth-child(1)]:h-1/3 [&_i:nth-child(2)]:h-2/3 [&_i:nth-child(3)]:h-full">
            <i />
            <i />
            <i />
            <i />
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-muted p-2" data-style={variant} aria-hidden>
      <span className="flex size-full flex-col overflow-hidden rounded-sm border border-border bg-card">
        <span className="flex h-3 items-center gap-1 border-b border-border px-1 [&_i]:size-1 [&_i]:rounded-full [&_i]:bg-muted-foreground">
          <i />
          <i />
          <i />
        </span>
        <span className="flex min-h-0 flex-1">
          <span className="flex w-1/4 flex-col gap-1 border-r border-border p-1 [&_i]:h-1 [&_i]:bg-muted">
            <i />
            <i />
            <i />
          </span>
          <span className="flex flex-1 flex-col gap-1 p-1">
            <span className="h-2 w-1/2 bg-foreground/50" />
            <span className="grid grid-cols-3 gap-1 [&_i]:h-5 [&_i]:rounded-sm [&_i]:bg-accent">
              <i />
              <i />
              <i />
            </span>
            <span className="flex flex-col gap-1 [&_i]:h-1 [&_i]:bg-muted">
              <i />
              <i />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

function DirectionCardView({
  card,
  formId,
  questionId,
  selected,
  disabled,
  onSelect,
  t,
}: {
  card: DirectionCard;
  formId: string;
  questionId: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  // Form-language-aware translator from the owning card (see QuestionFormView).
  t: (key: Parameters<ReturnType<typeof useT>>[0]) => string;
}) {
  return (
    <label
      className={cn('flex cursor-pointer flex-col gap-3 rounded-lg border border-border bg-card p-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', selected ? 'border-primary bg-accent' : '', disabled ? 'cursor-not-allowed opacity-50' : '')}
    >
      <Input className="sr-only"
        type="radio"
        name={`${formId}-${questionId}`}
        value={card.id}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect()}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{card.label}</div>
        {selected ? <span className="rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">{t('questionForm.cardSelected')}</span> : null}
      </div>
      {card.palette.length > 0 ? (
        <div className="flex gap-1" aria-hidden>
          {card.palette.slice(0, 6).map((c, i) => (
            <span
              key={i}
              className="size-6 rounded-sm border border-border"
              style={{ background: c }}
              title={c}
            />
          ))}
        </div>
      ) : null}
      <div className="flex items-baseline gap-3" aria-hidden>
        <span className="text-3xl" style={{ fontFamily: card.displayFont }}>
          Aa
        </span>
        <span className="text-sm" style={{ fontFamily: card.bodyFont }}>
          {t('questionForm.cardSampleText')}
        </span>
      </div>
      {card.mood ? <p className="text-sm text-muted-foreground">{card.mood}</p> : null}
      {card.references.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">{t('questionForm.cardRefs')}</span>{' '}
          {card.references.slice(0, 4).join(' · ')}
        </p>
      ) : null}
    </label>
  );
}

function buildInitialState(
  form: QuestionForm,
  submitted: Record<string, string | string[]> | undefined,
  draft: Record<string, string | string[]> | undefined,
  visualStyleContext: VisualStyleContext | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of form.questions) {
    if (submitted && submitted[q.id] !== undefined) {
      out[q.id] = canonicalizeQuestionValue(q, submitted[q.id]!, visualStyleContext);
      continue;
    }
    if (draft && draft[q.id] !== undefined && q.type !== 'file') {
      out[q.id] = canonicalizeQuestionValue(q, draft[q.id]!, visualStyleContext);
      continue;
    }
    if (q.defaultValue !== undefined) {
      out[q.id] = canonicalizeQuestionValue(q, q.defaultValue, visualStyleContext);
      continue;
    }
    out[q.id] = emptyQuestionValue(q);
  }
  return out;
}

/**
 * Whether a question that already holds a value should adopt a
 * later-arriving streamed `default`.
 *
 * The partial-JSON parser reveals a question as soon as its label lands, but
 * models are free to emit the `default` key after `options` — so the reveal
 * pass can park a question on its auto-assigned empty value before the
 * recommendation has streamed in. Invariant: a late default fills a question
 * only while (a) the user has never touched it and (b) it still holds that
 * auto-assigned empty value, so it can never clobber a real answer or an
 * intentional clear.
 */
function shouldAdoptStreamedDefault(
  q: QuestionForm['questions'][number],
  current: string | string[],
  touched: ReadonlySet<string>,
): boolean {
  if (q.defaultValue === undefined || touched.has(q.id)) return false;
  if (Array.isArray(current)) return current.length === 0;
  return current === emptyQuestionValue(q);
}

function draftSafeAnswers(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const fileQuestionIds = new Set(
    form.questions.filter((q) => q.type === 'file').map((q) => q.id),
  );
  if (fileQuestionIds.size === 0) return answers;
  const out: Record<string, string | string[]> = {};
  for (const [id, value] of Object.entries(answers)) {
    if (!fileQuestionIds.has(id)) out[id] = value;
  }
  return out;
}

function answersWithSkippedQuestions(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
  skippedQuestionIds: ReadonlySet<string>,
): Record<string, string | string[]> {
  if (skippedQuestionIds.size === 0) return answers;
  const submittedAnswers = { ...answers };
  for (const q of form.questions) {
    if (skippedQuestionIds.has(q.id)) {
      submittedAnswers[q.id] = emptyQuestionValue(q);
    }
  }
  return submittedAnswers;
}

function collectFileSubmissions(
  form: QuestionForm,
  fileAnswers: Record<string, File[]>,
  skippedQuestionIds: ReadonlySet<string>,
): QuestionFormFileSubmission[] {
  const out: QuestionFormFileSubmission[] = [];
  for (const q of form.questions) {
    if (q.type !== 'file' || skippedQuestionIds.has(q.id)) continue;
    const files = fileAnswers[q.id] ?? [];
    if (files.length === 0) continue;
    out.push({ questionId: q.id, questionLabel: q.label, files });
  }
  return out;
}

function emptyQuestionValue(q: QuestionForm['questions'][number]): string | string[] {
  if (q.type === 'checkbox') return [];
  if (q.type === 'switch') return 'false';
  if (q.type === 'range') return String(q.min ?? 0);
  if (q.type === 'color') return normalizeColorInputValue('');
  return '';
}

function formWithVisualStyleOptions(
  form: QuestionForm,
  visualStyleContext: VisualStyleContext | undefined,
): QuestionForm {
  if (!visualStyleContext) return form;
  let expanded = false;
  const questions = form.questions.map((question) => {
    if (
      question.id !== 'tone' ||
      (question.type !== 'checkbox' && question.type !== 'radio') ||
      !question.options
    ) {
      return question;
    }
    expanded = true;
    return {
      ...question,
      options: visualStyleCardsForContext(visualStyleContext).map((card) => ({
        label: card.title,
        value: card.value,
        description: card.description,
      })),
    };
  });
  return expanded ? { ...form, questions } : form;
}

function questionAnswerIsPresent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalizeQuestionValue(
  q: QuestionForm['questions'][number],
  value: string | string[],
  visualStyleContext: VisualStyleContext | undefined,
): string | string[] {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeVisualStyleQuestionValue(q, entry, visualStyleContext),
    );
  }
  return normalizeVisualStyleQuestionValue(q, value, visualStyleContext);
}

const LEGACY_VISUAL_STYLE_VARIANTS: Readonly<Record<string, VisualStyleVariant>> = {
  editorial: 'editorial',
  'editorial / magazine': 'editorial',
  magazine: 'editorial',
  minimal: 'minimal',
  'modern minimal': 'minimal',
  'modern-minimal': 'minimal',
  'soft gradients': 'minimal',
  'soft-gradient': 'minimal',
  'soft-gradients': 'minimal',
  playful: 'playful',
  'playful / illustrative': 'playful',
  illustrative: 'playful',
  utility: 'utility',
  'tech / utility': 'utility',
  tech: 'utility',
  luxury: 'luxury',
  'luxury / refined': 'luxury',
  refined: 'luxury',
  brutalist: 'brutalist',
  experimental: 'brutalist',
  human: 'human',
  'human / approachable': 'human',
  approachable: 'human',
};

/**
 * Maps the original seven tone aliases to the full catalog's stable card
 * IDs. Unknown/custom answers deliberately pass through unchanged.
 */
export function normalizeVisualStyleQuestionValue(
  q: QuestionForm['questions'][number],
  value: string,
  visualStyleContext: VisualStyleContext | undefined,
): string {
  const optionValue = formOptionValueForLabel(q, value);
  if (
    !visualStyleContext ||
    q.id !== 'tone' ||
    (q.type !== 'checkbox' && q.type !== 'radio')
  ) {
    return optionValue;
  }

  const cards = visualStyleCardsForContext(visualStyleContext);
  const normalized = optionValue.trim().toLocaleLowerCase();
  const directMatch = cards.find(
    (card) =>
      card.value.toLocaleLowerCase() === normalized ||
      card.title.toLocaleLowerCase() === normalized,
  );
  if (directMatch) return directMatch.value;

  const variant = LEGACY_VISUAL_STYLE_VARIANTS[normalized];
  return variant
    ? (cards.find((card) => card.variant === variant)?.value ?? optionValue)
    : optionValue;
}

function shouldRenderCustomChoice(q: QuestionForm['questions'][number]): boolean {
  return q.allowCustom !== false;
}

function questionValueIsKnown(q: QuestionForm['questions'][number], value: string): boolean {
  if (q.options?.some((option) => option.value === value || option.label === value)) return true;
  if (q.cards?.some((card) => card.id === value || card.label === value)) return true;
  return false;
}

function customSingleValue(
  q: QuestionForm['questions'][number],
  value: string | string[] | undefined,
): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return questionValueIsKnown(q, value) ? '' : value;
}

function customCheckboxValue(
  q: QuestionForm['questions'][number],
  value: string | string[] | undefined,
): string {
  if (!Array.isArray(value)) return '';
  return value.filter((entry) => !questionValueIsKnown(q, entry)).join(', ');
}

function splitCustomEntries(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function customInputCharCount(value: string, placeholder: string): number {
  const base = value.length > 0 ? value.length : Math.min(placeholder.length, 22);
  return Math.max(18, Math.min(base + 2, 72));
}

function normalizeColorInputValue(value: string | string[] | undefined): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return '#000000';
}

function fileValueLabel(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

/**
 * Reverse of formatFormAnswers — when we render an old assistant message
 * that contained a form, look at the next user message in the conversation
 * to see if the form was already answered. If so, return the answers map
 * so the form renders in the locked "answered" state with the user's
 * picks visible.
 */
export function parseSubmittedAnswers(
  form: QuestionForm,
  userMessageContent: string,
): Record<string, string | string[]> | null {
  const lines = userMessageContent.split('\n').map((l) => l.trim());
  if (lines.length === 0) return null;
  const header = lines[0] ?? '';
  // We accept any "form answers" header so the agent can paraphrase.
  if (!/^\[form answers/i.test(header)) return null;
  const answers: Record<string, string | string[]> = {};
  const labelToId = new Map<string, string>();
  for (const q of form.questions) labelToId.set(q.label.toLowerCase(), q.id);
  const uploadSummaryIndex = lines.findIndex((line) => /^\[uploaded design files\]$/i.test(line));
  const answerLines = uploadSummaryIndex === -1 ? lines : lines.slice(0, uploadSummaryIndex);
  for (let i = 1; i < answerLines.length; i++) {
    const line = answerLines[i] ?? '';
    const m = /^[-*]\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const labelKey = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    const id = labelToId.get(labelKey);
    if (!id) continue;
    const q = form.questions.find((x) => x.id === id);
    if (!q) continue;
    if (q.type === 'checkbox') {
      answers[id] = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.toLowerCase() !== '(skipped)')
        .map((s) => formOptionValueForLabel(q, parseSubmittedOptionToken(s)));
    } else {
      answers[id] = value.toLowerCase() === '(skipped)' ? '' : formOptionValueForLabel(q, parseSubmittedOptionToken(value));
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function parseSubmittedOptionToken(raw: string): string {
  const match = /\s+\[value:\s*([^\]]+)\]\s*$/i.exec(raw);
  if (!match) return raw.trim();
  return match[1]!.trim();
}
