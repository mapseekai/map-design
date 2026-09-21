import type { MapApiProfileInput } from '@mapseekai/contracts';
import { Button, Checkbox, Field, FieldLabel, Input, Select, SelectTrigger, SelectValue, SelectContent,
  SelectItem, SelectGroup, FieldGroup } from '@mapseekai/components';
import { useI18n } from '../../i18n';
import { settingsCopy } from '../../i18n/locales/settings';
import { apiModelCopy } from '../../i18n/locales/api-model';
import { apiProfilesCopy } from '../../i18n/locales/api-profiles';

export function ApiProfileForm({ value, hasApiKey, disabled, dirty, isNew = false, onChange, onSave, onCancel }: {
  value: MapApiProfileInput; hasApiKey: boolean; disabled: boolean; dirty: boolean; isNew?: boolean;
  onChange(value: MapApiProfileInput): void; onSave(): void; onCancel(): void;
}) {
  const { locale, t } = useI18n(); const copy = apiProfilesCopy[locale]; const labels = settingsCopy[locale];
  const update = (patch: Partial<MapApiProfileInput>) => onChange({ ...value, ...patch });
  return <form onSubmit={(event) => { event.preventDefault(); onSave(); }} aria-label={copy.edit}>
    <FieldGroup>
      <Field><FieldLabel htmlFor="api-profile-name">{copy.name}</FieldLabel>
        <Input id="api-profile-name" value={value.name} maxLength={120} required disabled={disabled}
          onChange={(event) => update({ name: event.target.value })} placeholder={copy.name} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field><FieldLabel htmlFor="api-profile-protocol">{labels.protocol}</FieldLabel>
          <Select disabled={disabled} value={value.protocol} items={[{ value: 'openai', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic' }]}
            onValueChange={(protocol) => { if (protocol === 'openai' || protocol === 'anthropic') update({ protocol }); }}>
            <SelectTrigger id="api-profile-protocol"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
              <SelectItem data-value="openai" value="openai">OpenAI-compatible</SelectItem><SelectItem data-value="anthropic" value="anthropic">Anthropic</SelectItem>
            </SelectGroup></SelectContent></Select></Field>
        {value.protocol === 'openai' ? <Field><FieldLabel htmlFor="api-profile-format">{apiModelCopy[locale].format}</FieldLabel>
          <Select disabled={disabled} value={value.apiFormat} items={[{ value: 'chat-completions', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }]}
            onValueChange={(apiFormat) => { if (apiFormat === 'chat-completions' || apiFormat === 'responses') update({ apiFormat }); }}>
            <SelectTrigger id="api-profile-format"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
              <SelectItem data-value="chat-completions" value="chat-completions">Chat Completions</SelectItem><SelectItem data-value="responses" value="responses">Responses</SelectItem>
            </SelectGroup></SelectContent></Select></Field> : null}
      </div>
      <Field><FieldLabel htmlFor="api-profile-endpoint">{labels.baseUrl}</FieldLabel>
        <Input id="api-profile-endpoint" value={value.baseUrl} type="url" disabled={disabled} maxLength={4096}
          placeholder={value.protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1'}
          onChange={(event) => update({ baseUrl: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor="api-profile-model">{apiModelCopy[locale].model}</FieldLabel>
        <Input id="api-profile-model" value={value.model} required maxLength={256} disabled={disabled}
          onChange={(event) => update({ model: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor="api-profile-key">{labels.apiKey}</FieldLabel>
        <Input id="api-profile-key" value={value.apiKey ?? ''} type="password" autoComplete="new-password" maxLength={16384}
          disabled={disabled} placeholder={hasApiKey ? copy.keySaved : ''}
          required={value.requiresApiKey && !hasApiKey} onChange={(event) => update({ apiKey: event.target.value })} />
        {hasApiKey ? <p className="text-xs text-muted-foreground">{copy.keySaved}</p> : null}
      </Field>
      <Field orientation="horizontal"><Checkbox id="api-profile-requires-key" checked={value.requiresApiKey} disabled={disabled}
        onCheckedChange={(checked) => update({ requiresApiKey: checked === true })} />
        <FieldLabel htmlFor="api-profile-requires-key">{copy.requiresKey}</FieldLabel></Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={disabled || !dirty}>{disabled ? t('common.loading') : copy.save}</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={onCancel}>{copy.cancel}</Button>
        <span className="text-xs text-muted-foreground">{dirty ? copy.unsaved : isNew ? copy.notSaved : copy.saved}</span>
      </div>
    </FieldGroup>
  </form>;
}
