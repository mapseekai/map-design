import { Field, FieldLabel, FieldSet, FieldLegend, Input } from '@mapseekai/components';
import { MAP_API_EXECUTION_BOUNDS, type MapDesignApiExecutionSettings, resolveMapApiExecutionSettings } from '@mapseekai/contracts';
import { useI18n } from '../../i18n';
import { apiExecutionCopy } from '../../i18n/locales/api-execution';

export function ApiExecutionFields({ value, onChange, disabled }: {
  value: Required<MapDesignApiExecutionSettings>;
  onChange(value: Required<MapDesignApiExecutionSettings>): void;
  disabled: boolean;
}) {
  const { locale } = useI18n(); const copy = apiExecutionCopy[locale];
  let valid = true;
  try { resolveMapApiExecutionSettings(value); } catch { valid = false; }
  return <FieldSet disabled={disabled}>
    <FieldLegend>{copy.title}</FieldLegend><p>{copy.hint}</p>
    {(Object.keys(MAP_API_EXECUTION_BOUNDS) as Array<keyof typeof MAP_API_EXECUTION_BOUNDS>).map((name) => {
      const [min, max] = MAP_API_EXECUTION_BOUNDS[name];
      return <Field key={name}><FieldLabel htmlFor={`api-budget-${name}`}>{copy[name]} ({min}–{max})</FieldLabel>
        <Input id={`api-budget-${name}`} type="number" min={min} max={max} step={1} value={Number.isNaN(value[name]) ? '' : value[name]}
          onChange={(event) => onChange({ ...value, [name]: event.target.value === '' ? Number.NaN : Number(event.target.value) })} />
      </Field>;
    })}
    {!valid ? <p role="alert">{copy.invalid}</p> : null}
  </FieldSet>;
}
