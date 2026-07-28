import { Type } from '@sinclair/typebox';

/** How a DCG field was determined: observed, declared in upstream spec, or inferred. */
export const Provenance = Type.Union(
  [Type.Literal('observed'), Type.Literal('declared'), Type.Literal('inferred')],
  {
    description:
      'How this value was determined: observed from traffic, declared in an upstream spec, or inferred by analysis/AI.',
  },
);
