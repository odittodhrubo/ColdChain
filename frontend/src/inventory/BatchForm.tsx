import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useFridges } from '../lib/queries';
import type { Batch } from '../lib/types';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

const today = () => new Date().toISOString().slice(0, 10);

interface Values {
  name: string;
  manufacturer: string;
  lot_number: string;
  quantity: string;
  expiry_date: string;
  criticality: string;
  fridge_id: string;
}

function validate(v: Values, creating: boolean): Partial<Record<keyof Values, string>> {
  const e: Partial<Record<keyof Values, string>> = {};
  if (!v.name.trim()) e.name = 'Enter the product name';
  if (creating && !v.manufacturer.trim()) e.manufacturer = 'Enter the manufacturer';
  if (creating && !v.lot_number.trim()) e.lot_number = 'Enter the lot number';
  const q = Number(v.quantity);
  if (!Number.isInteger(q) || q < (creating ? 1 : 0))
    e.quantity = creating ? 'At least 1 dose' : 'A whole number, 0 or more';
  if (!v.expiry_date) e.expiry_date = 'Pick the expiry date';
  else if (v.expiry_date <= today()) e.expiry_date = 'The expiry date must be in the future';
  if (creating && !v.fridge_id) e.fridge_id = 'Choose a fridge';
  return e;
}

/** Add a batch (into a fridge) or edit name, quantity, criticality and expiry. Validates before sending. */
export function BatchForm({ batch, open, onClose }: { batch?: Batch; open: boolean; onClose: () => void }) {
  const creating = !batch;
  const fridges = useFridges();
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<Values>(() => ({
    name: batch?.name ?? '',
    manufacturer: batch?.manufacturer ?? '',
    lot_number: batch?.lot_number ?? '',
    quantity: String(batch?.quantity ?? ''),
    expiry_date: batch?.expiry_date ?? '',
    criticality: String(batch?.criticality ?? 2),
    fridge_id: batch?.fridge_id ?? '',
  }));
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({});
  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: values.name.trim(),
        quantity: Number(values.quantity),
        expiry_date: values.expiry_date,
        criticality: Number(values.criticality),
      };
      return creating
        ? api<{ batch: Batch }>('/api/batches', {
            method: 'POST',
            body: {
              ...common,
              manufacturer: values.manufacturer.trim(),
              lot_number: values.lot_number.trim(),
              fridge_id: values.fridge_id,
            },
          })
        : api<{ batch: Batch }>(`/api/batches/${batch.id}`, { method: 'PATCH', body: common });
    },
    onSuccess: ({ batch: b }) => {
      toast({ tone: 'success', title: creating ? `${b.name} added` : `${b.name} saved` });
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['fridges'] });
      onClose();
    },
  });
  const set = (k: keyof Values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validate(values, creating);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  const serverError = save.error instanceof ApiError ? save.error : null;
  const formId = creating ? 'batch-form-new' : `batch-form-${batch.id}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={creating ? 'Add batch' : `Edit ${batch.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {creating ? 'Add batch' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        {serverError && (
          <p
            role="alert"
            className="rounded-md border border-breach/40 bg-breach-wash px-3 py-2 text-sm font-medium text-breach sm:col-span-2"
          >
            {serverError.code === 'FRIDGE_FULL'
              ? 'That fridge is full. Choose another one.'
              : serverError.message}
          </p>
        )}
        <Field
          label="Product name"
          value={values.name}
          onChange={set('name')}
          error={errors.name}
          className="sm:col-span-2"
        />
        {creating && (
          <>
            <Field
              label="Manufacturer"
              value={values.manufacturer}
              onChange={set('manufacturer')}
              error={errors.manufacturer}
            />
            <Field
              label="Lot number"
              value={values.lot_number}
              onChange={set('lot_number')}
              error={errors.lot_number}
            />
          </>
        )}
        <Field
          label="Quantity (doses)"
          type="number"
          inputMode="numeric"
          min={creating ? 1 : 0}
          value={values.quantity}
          onChange={set('quantity')}
          error={errors.quantity}
        />
        <Field
          label="Expiry date"
          type="date"
          min={today()}
          value={values.expiry_date}
          onChange={set('expiry_date')}
          error={errors.expiry_date}
        />
        <Select label="Criticality" value={values.criticality} onChange={set('criticality')}>
          <option value="1">1 · low</option>
          <option value="2">2 · medium</option>
          <option value="3">3 · high</option>
        </Select>
        {creating && (
          <Select
            label="Fridge"
            value={values.fridge_id}
            onChange={set('fridge_id')}
            error={errors.fridge_id}
          >
            <option value="">Choose…</option>
            {fridges.data?.fridges.map((f) => (
              <option key={f.id} value={f.id} disabled={f.load >= f.capacity}>
                {f.name} ({f.load}/{f.capacity}){f.load >= f.capacity ? ' · full' : ''}
              </option>
            ))}
          </Select>
        )}
      </form>
    </Modal>
  );
}
