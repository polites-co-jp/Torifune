/**
 * 共通コンポーネントの公開入口。
 *
 * **Plugin はここだけを見る**（06_画面設計.md §32）。
 * 個別ファイルへの直接 import を許すと、内部の再編で Plugin が壊れる。
 *
 * `010-plugin-api` で `packages/plugin-api` からこの型を参照できるようにする。
 */

export {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Select,
  Spinner,
  Textarea,
  type AlertProps,
  type AlertTone,
  type ButtonProps,
  type ButtonVariant,
  type CardProps,
  type CheckboxProps,
} from './primitives';

export { FormField, type FormFieldProps } from './form-field';

export { Pagination, Table, type Column, type PaginationProps, type TableProps } from './table';

export { Tabs, type TabItem, type TabsProps } from './tabs';

export { Chart, type ChartProps } from './chart';
export type { ChartPoint } from './chart-geometry';

export { DateField, type DateFieldProps } from './date-field';

export {
  ConfirmDialog,
  EmptyState,
  Modal,
  SecretField,
  Toast,
  type ConfirmDialogProps,
  type EmptyStateProps,
  type ModalProps,
  type SecretFieldProps,
  type ToastMessage,
  type ToastProps,
} from './overlays';
