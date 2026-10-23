import { verifySecretAsync } from './password'

export interface PinHolder {
  id: string
  pinHash: string
}

/**
 * The ids of the holders whose PIN is `pin`. A PIN identifies nobody by itself (the till asks for
 * the user first), so the two callers that start from a bare PIN, the manager override and the
 * "is this PIN taken" check, must test it against every holder. The verifications run together:
 * the thread pool does 4 at a time, so ten users cost about 300 ms rather than a second.
 */
export async function findPinHolders(pin: string, holders: readonly PinHolder[]): Promise<string[]> {
  const matched = await Promise.all(
    holders.map(async (holder) => ((await verifySecretAsync(pin, holder.pinHash)) ? holder.id : null))
  )
  return matched.filter((id): id is string => id !== null)
}
