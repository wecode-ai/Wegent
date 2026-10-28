import contract from '../../../../packages/chat-core/test-fixtures/conversation-search-contract.json' with { type: 'json' }

export const SEARCH_CONTRACT_TURN_START = 80
export const SEARCH_CONTRACT_CASES = contract.cases
export const searchContractCase = index => contract.cases[index - SEARCH_CONTRACT_TURN_START]

/** Use the same expected visible regions as the TS/Rust adapter contract. */
export const SEARCH_CONTRACT_QUERIES = Array.from(
  new Set(
    contract.cases.flatMap(fixture =>
      fixture.queries.filter(query => query.e2e !== false).map(query => query.query)
    )
  )
)
  // Broad placeholder words already have full-conversation positive/negative cases.
  .filter(query => !['cancelled', 'interrupted', 'aborted'].includes(query))
  .map(query => ({
    query,
    matches: contract.cases.flatMap((fixture, index) =>
      fixture.queries
        .filter(test => test.query === query)
        .flatMap(test =>
          test.matches.map((match, matchIndex) => ({
            ...match,
            occurrence: test.matches
              .slice(0, matchIndex)
              .filter(previous => previous.regionId === match.regionId).length,
            fixture,
            index: SEARCH_CONTRACT_TURN_START + index,
            region: fixture.regions.find(region => region.id === match.regionId),
            itemIndex: fixture.items.findIndex(item => item.id === match.regionId),
            narrative: fixture.items.find(item => item.id === match.regionId)?.kind === 'narrative',
            userMessage: fixture.items.find(item => item.id === match.regionId)?.kind === 'user',
          }))
        )
    ),
  }))

export function searchContractParts(fixture) {
  return fixture.items.map(item => ({
    text: item.content,
    phase: item.kind === 'narrative' ? 'commentary' : 'final_answer',
    kind: item.kind,
  }))
}

export const contractTerminal = fixture => ({
  status:
    fixture.status === 'cancelled'
      ? 'interrupted'
      : fixture.status === 'failed'
        ? 'failed'
        : 'completed',
  text: [...fixture.items].reverse().find(item => item.kind === 'final')?.content ?? '',
  ...(fixture.error ? { error: { message: fixture.error } } : {}),
})
