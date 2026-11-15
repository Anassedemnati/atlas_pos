import { useTranslation } from 'react-i18next'
import type { PrintJobDto } from '@shared/dto'
import { useApi } from '../../app/api'
import { Button, Modal, Pill } from '../../ui'

export interface PrinterJobsDialogProps {
  open: boolean
  jobs: PrintJobDto[]
  onClose: () => void
  onChanged: () => void
}

/** The print jobs that need a person: failed or uncertain ones, to print again or to dismiss. */
export function PrinterJobsDialog({ open, jobs, onClose, onChanged }: PrinterJobsDialogProps) {
  const { t } = useTranslation()
  const api = useApi()
  const act = async (channel: 'printing.reprintJob' | 'printing.dismissJob', jobId: string) => {
    await api.call(channel, { jobId })
    onChanged()
  }
  return (
    <Modal open={open} onClose={onClose} title={t('till.printJobs.title')} size="md">
      {jobs.length === 0 ? (
        <p className="muted">{t('till.printJobs.none')}</p>
      ) : (
        <ul className="plain-list" data-testid="print-jobs">
          {jobs.map((job) => (
            <li key={job.id} className="job-row">
              <div className="grow">
                <strong>{t(`till.printJobs.kind.${job.kind}`)}</strong>
                <span className="muted"> · {job.printerName ?? ''}</span>
                <div>
                  <Pill tone={job.status === 'failed' ? 'danger' : 'warning'}>{t(`till.printJobs.status.${job.status}`)}</Pill>
                </div>
              </div>
              <Button variant="secondary" onClick={() => void act('printing.reprintJob', job.id)}>
                {t('till.printJobs.reprint')}
              </Button>
              <Button variant="secondary" onClick={() => void act('printing.dismissJob', job.id)}>
                {t('till.printJobs.dismiss')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
