import type { Locale } from '../types';

type SaveCopy = { overwrite: string; copySuffix: string; hint: string; failed: string; duplicate: string };
const copy = (overwrite: string, copySuffix: string, hint: string, failed: string, duplicate: string): SaveCopy => ({ overwrite, copySuffix, hint, failed, duplicate });

export const cartographySaveCopy: Record<Locale, SaveCopy> = {
  en: copy('Overwrite specification', 'copy', 'Draft saved automatically. Overwrite the current specification or save a new copy.', 'The specification could not be saved. Your draft is preserved. Retry or save a new copy.', 'This specification already exists. Choose a different name.'),
  'zh-CN': copy('覆盖保存', '副本', '草稿自动保存。可覆盖当前规范，或另存为一份新规范。', '规范保存失败，草稿已保留。请重试或另存为新规范。', '此规范已存在，请使用其他名称。'),
  'zh-TW': copy('覆蓋儲存', '副本', '草稿自動儲存。可覆蓋目前規範，或另存為新規範。', '規範儲存失敗，草稿已保留。請重試或另存新規範。', '此規範已存在，請使用其他名稱。'),
  de: copy('Spezifikation überschreiben', 'Kopie', 'Entwurf automatisch gespeichert. Aktuelle Spezifikation überschreiben oder eine Kopie speichern.', 'Speichern fehlgeschlagen. Der Entwurf bleibt erhalten. Erneut versuchen oder eine Kopie speichern.', 'Diese Spezifikation existiert bereits. Wähle einen anderen Namen.'),
  fr: copy('Remplacer la spécification', 'copie', 'Brouillon enregistré automatiquement. Remplacez la spécification ou enregistrez une copie.', 'Enregistrement impossible. Le brouillon est conservé. Réessayez ou enregistrez une copie.', 'Cette spécification existe déjà. Choisissez un autre nom.'),
  'es-ES': copy('Sobrescribir especificación', 'copia', 'Borrador guardado automáticamente. Sobrescribe la especificación o guarda una copia.', 'No se pudo guardar. El borrador se conserva. Reintenta o guarda una copia.', 'Esta especificación ya existe. Elige otro nombre.'),
  'pt-BR': copy('Sobrescrever especificação', 'cópia', 'Rascunho salvo automaticamente. Sobrescreva a especificação ou salve uma cópia.', 'Não foi possível salvar. O rascunho foi preservado. Tente novamente ou salve uma cópia.', 'Esta especificação já existe. Escolha outro nome.'),
  it: copy('Sovrascrivi specifica', 'copia', 'Bozza salvata automaticamente. Sovrascrivi la specifica o salva una copia.', 'Salvataggio non riuscito. La bozza è conservata. Riprova o salva una copia.', 'Questa specifica esiste già. Scegli un altro nome.'),
  ja: copy('仕様を上書き保存', 'コピー', '下書きは自動保存されます。現在の仕様を上書きするか、新しいコピーを保存できます。', '保存できませんでした。下書きは保持されています。再試行するか、別名で保存してください。', 'この仕様は既に存在します。別の名前を入力してください。'),
  ko: copy('규격 덮어쓰기', '사본', '초안은 자동 저장됩니다. 현재 규격을 덮어쓰거나 새 사본을 저장하세요.', '저장하지 못했습니다. 초안은 유지됩니다. 다시 시도하거나 사본으로 저장하세요.', '이미 존재하는 규격입니다. 다른 이름을 입력하세요.'),
  id: copy('Timpa spesifikasi', 'salinan', 'Draf tersimpan otomatis. Timpa spesifikasi saat ini atau simpan salinan baru.', 'Spesifikasi tidak dapat disimpan. Draf tetap tersimpan. Coba lagi atau simpan salinan.', 'Spesifikasi ini sudah ada. Pilih nama lain.'),
  ru: copy('Перезаписать спецификацию', 'копия', 'Черновик сохраняется автоматически. Перезапишите спецификацию или сохраните копию.', 'Не удалось сохранить. Черновик сохранён. Повторите попытку или сохраните копию.', 'Такая спецификация уже существует. Выберите другое имя.'),
  uk: copy('Перезаписати специфікацію', 'копія', 'Чернетка зберігається автоматично. Перезапишіть специфікацію або збережіть копію.', 'Не вдалося зберегти. Чернетку збережено. Повторіть спробу або збережіть копію.', 'Така специфікація вже існує. Виберіть іншу назву.'),
  pl: copy('Nadpisz specyfikację', 'kopia', 'Szkic zapisuje się automatycznie. Nadpisz specyfikację lub zapisz nową kopię.', 'Nie udało się zapisać. Szkic zachowano. Spróbuj ponownie lub zapisz kopię.', 'Ta specyfikacja już istnieje. Wybierz inną nazwę.'),
  hu: copy('Specifikáció felülírása', 'másolat', 'A vázlat automatikusan mentődik. Írja felül a specifikációt, vagy mentse másolatként.', 'A mentés sikertelen. A vázlat megmaradt. Próbálja újra, vagy mentse másolatként.', 'Ez a specifikáció már létezik. Válasszon másik nevet.'),
  tr: copy('Belirtimin üzerine yaz', 'kopya', 'Taslak otomatik kaydedilir. Belirtimin üzerine yazın veya yeni bir kopya kaydedin.', 'Kaydedilemedi. Taslak korundu. Yeniden deneyin veya kopya olarak kaydedin.', 'Bu belirtim zaten var. Başka bir ad seçin.'),
  th: copy('บันทึกทับข้อกำหนด', 'สำเนา', 'บันทึกร่างอัตโนมัติ บันทึกทับข้อกำหนดปัจจุบันหรือบันทึกสำเนาใหม่ได้', 'บันทึกไม่สำเร็จ ร่างยังคงอยู่ โปรดลองอีกครั้งหรือบันทึกเป็นสำเนาใหม่', 'มีข้อกำหนดนี้อยู่แล้ว โปรดใช้ชื่ออื่น'),
  ar: copy('استبدال المواصفة', 'نسخة', 'تُحفظ المسودة تلقائياً. استبدل المواصفة الحالية أو احفظ نسخة جديدة.', 'تعذر الحفظ. المسودة محفوظة. أعد المحاولة أو احفظ نسخة جديدة.', 'هذه المواصفة موجودة بالفعل. اختر اسماً آخر.'),
  fa: copy('بازنویسی مشخصات', 'نسخه', 'پیش‌نویس خودکار ذخیره می‌شود. مشخصات فعلی را بازنویسی کنید یا نسخه‌ای جدید ذخیره کنید.', 'ذخیره نشد. پیش‌نویس حفظ شده است. دوباره تلاش کنید یا نسخه‌ای جدید ذخیره کنید.', 'این مشخصات از قبل وجود دارد. نام دیگری انتخاب کنید.'),
};
