import type { LocalAgentInfo } from '@mapseekai/contracts';
import { Field, FieldLabel, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@mapseekai/components';
import { useI18n } from '../../i18n';
import { sourceFormCopy } from '../../i18n/locales/source-form';
import { apiProfilesCopy } from '../../i18n/locales/api-profiles';

export function AgentModelFields({ id, agents, agentId, model, disabled = false, onAgentChange, onModelChange }: {
  id: string; agents: LocalAgentInfo[]; agentId: string; model: string; disabled?: boolean;
  onAgentChange(value: string): void; onModelChange(value: string): void;
}) {
  const { t, locale } = useI18n();
  const copy = sourceFormCopy[locale];
  const selectedAgent = agents.find(agent => agent.id === agentId && agent.available);
  const apiModels = selectedAgent?.id === 'api' ? selectedAgent.models?.filter(model => model.enabled) ?? [] : [];
  const selectedApiModel = model ? apiModels.find(item => item.id === model) : apiModels.find(item => item.default);
  const agentOptionLabel = (agent: LocalAgentInfo) => {
    if (!agent.available || agent.mapDesign.reason === 'agent-unavailable') return agent.label;
    if (!agent.mapDesign.nativeMapTools) return `${agent.label} — ${t('mapDesign.agent.mapEditingUnavailable')}`;
    return agent.mapDesign.publicReasoningSummary
      ? `${agent.label} — ${t('mapDesign.agent.publicReasoningSummaryAvailable')}`
      : agent.label;
  };

  return <>
    <Field>
      <FieldLabel htmlFor={id}>{copy.agent}</FieldLabel>
      <Select disabled={disabled} value={agentId || '__none__'}
        items={[{ value: '__none__', label: copy.selectAgent }, ...agents.map(agent => ({ value: agent.id, label: agentOptionLabel(agent) }))]}
        onValueChange={value => onAgentChange(value === '__none__' ? '' : value ?? '')}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          <SelectItem data-value="__none__" value="__none__">{copy.selectAgent}</SelectItem>
          {agents.map(agent => <SelectItem key={agent.id} data-value={agent.id} value={agent.id} disabled={!agent.available}>
            {agentOptionLabel(agent)}
          </SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    </Field>
    {selectedAgent?.id === 'api' ? <Field>
      <FieldLabel htmlFor={`${id}-model`}>{apiProfilesCopy[locale].title}</FieldLabel>
      <Select disabled={disabled} value={selectedApiModel?.id ?? '__none__'}
        items={[{ value: '__none__', label: apiModels.length ? apiProfilesCopy[locale].selectModel : apiProfilesCopy[locale].empty }, ...apiModels.map(model => ({ value: model.id, label: model.label }))]}
        onValueChange={value => onModelChange(value === '__none__' ? '' : value ?? '')}>
        <SelectTrigger id={`${id}-model`}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {!apiModels.length ? <SelectItem value="__none__">{apiProfilesCopy[locale].empty}</SelectItem> : null}
          {apiModels.map(model => <SelectItem key={model.id} value={model.id} data-value={model.id}>{model.label}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    </Field> : null}
  </>;
}
