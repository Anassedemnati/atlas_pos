import type { tillChannels } from '@shared/ipc/till'
import { createTillService, type TillService } from '../../application/usecases/till'
import type { Services } from '../../composition/services'
import type { Handlers, IpcDeps } from './context'

const services = new WeakMap<Services, TillService>()

/** The till service of an open database, built once per database (a restore builds a new `Services`). */
function tillOf(current: Services, deps: IpcDeps): TillService {
  let service = services.get(current)
  if (!service) {
    service = createTillService({
      db: current.db,
      uow: current.uow,
      settings: current.settings,
      spooler: current.print.queue,
      clock: deps.clock ?? { now: () => new Date() },
      overrides: current.users
    })
    services.set(current, service)
  }
  return service
}

/** Order lists, the pre-bill, ticket search, Z history, the user's language. */
export const tillHandlers: Handlers<keyof typeof tillChannels> = {
  'orders.list': (_input, ctx, deps) => tillOf(ctx.services(), deps).listOrders(ctx.session()),
  'orders.printPrebill': ({ orderId }, ctx, deps) => tillOf(ctx.services(), deps).printPrebill(ctx.session(), orderId),
  'tickets.list': (input, ctx, deps) => tillOf(ctx.services(), deps).listTickets(ctx.session(), input),
  'days.history': (_input, ctx, deps) => tillOf(ctx.services(), deps).zHistory(ctx.session()),
  'days.reprintZ': ({ zId }, ctx, deps) => tillOf(ctx.services(), deps).reprintZ(ctx.session(), zId),
  'users.setLang': ({ lang }, ctx, deps) => tillOf(ctx.services(), deps).setLang(ctx.session(), lang)
}
