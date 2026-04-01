/**
 * @dino/core — GraphQL introspection types
 *
 * Shared by introspection engine (root) and @dino/agents.
 * Keeps package layer independent of root src/introspection.
 */

export interface GraphQLOperation {
  name: string;
  type: 'query' | 'mutation' | 'subscription';
  description: string | null;
  args: Array<{
    name: string;
    type: string;
    isRequired: boolean;
  }>;
  returnType: string;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

export interface InputTypeField {
  name: string;
  type: string;
  isRequired: boolean;
}
