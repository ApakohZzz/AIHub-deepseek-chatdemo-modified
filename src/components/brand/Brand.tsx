import mark from '../../assets/aihub-orbit-web.png'
import wordmark from '../../assets/aihub-wordmark-web.png'
import styles from './Brand.module.css'

export const Brand = ({
  symbolOnly = false,
  className = '',
}: {
  symbolOnly?: boolean
  className?: string
}) => (
  <span className={`${styles.brand} ${className}`}>
    {symbolOnly ? (
      <img className={styles.mark} src={mark} alt="" draggable={false} />
    ) : (
      <img className={styles.lockup} src={wordmark} alt="AI Hub" draggable={false} />
    )}
  </span>
)
