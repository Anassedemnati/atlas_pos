import { v7 } from 'uuid'

/** New time-ordered identifier (UUIDv7 string). */
export function newId(): string {
  return v7()
}
