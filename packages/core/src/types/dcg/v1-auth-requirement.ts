import { Type } from '@sinclair/typebox';
import { Provenance } from './v1-provenance';

export const AuthRequirementSchema = Type.Object(
  {
    roles_tested: Type.Array(Type.String({ minLength: 1 }), {
      description: 'Auth states tested by RBAC agent (e.g., UNAUTHENTICATED, USER, ADMIN)',
    }),
    minimum_role: Type.Optional(
      Type.String({
        description: 'Lowest auth state that received a success response. Null if all denied.',
      }),
    ),
    unauthenticated: Type.Union(
      [Type.Literal('allowed'), Type.Literal('denied'), Type.Literal('inconclusive')],
      { description: 'What happens when no auth token is provided.' },
    ),
    provenance: Type.Optional(Provenance),
  },
  { additionalProperties: false },
);
