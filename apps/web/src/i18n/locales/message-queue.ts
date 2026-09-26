import type { Locale } from '../types';

type MessageQueueCopy = {
  readonly title: string;
  readonly count: string;
  readonly hint: string;
  readonly paused: string;
  readonly resume: string;
  readonly edit: string;
  readonly remove: string;
  readonly save: string;
  readonly cancel: string;
  readonly editLabel: string;
  readonly submitting: string;
  readonly enqueue: string;
  readonly placeholder: string;
  readonly attachments: string;
  readonly limit: string;
};

export const messageQueueCopy: Record<Locale, MessageQueueCopy> = {
  en: {
    title: 'Queued messages', count: '{count} queued', hint: 'Sent after the current task',
    paused: 'Queue paused', resume: 'Continue queue', edit: 'Edit queued message', remove: 'Delete queued message',
    save: 'Save', cancel: 'Cancel', editLabel: 'Edit message', submitting: 'Sending…',
    enqueue: 'Add to queue', placeholder: 'Add a follow-up to the queue…', attachments: 'Attachments: {count}',
    limit: 'Enter a message of 1–{limit} characters.',
  },
  'zh-CN': {
    title: '待发送消息', count: '{count} 条待发送', hint: '当前任务结束后依次发送',
    paused: '队列已暂停', resume: '继续队列', edit: '编辑待发送消息', remove: '删除待发送消息',
    save: '保存', cancel: '取消', editLabel: '编辑消息', submitting: '正在发送…',
    enqueue: '加入队列', placeholder: '继续输入，加入待发送队列…', attachments: '{count} 个附件',
    limit: '请输入 1–{limit} 个字符的消息。',
  },
  'zh-TW': {
    title: '待傳送訊息', count: '{count} 則待傳送', hint: '目前任務結束後依序傳送',
    paused: '佇列已暫停', resume: '繼續佇列', edit: '編輯待傳送訊息', remove: '刪除待傳送訊息',
    save: '儲存', cancel: '取消', editLabel: '編輯訊息', submitting: '正在傳送…',
    enqueue: '加入佇列', placeholder: '繼續輸入，加入待傳送佇列…', attachments: '{count} 個附件',
    limit: '請輸入 1–{limit} 個字元的訊息。',
  },
  id: {
    title: 'Antrean pesan', count: '{count} dalam antrean', hint: 'Dikirim setelah tugas saat ini',
    paused: 'Antrean dijeda', resume: 'Lanjutkan antrean', edit: 'Edit pesan antrean', remove: 'Hapus pesan antrean',
    save: 'Simpan', cancel: 'Batal', editLabel: 'Edit pesan', submitting: 'Mengirim…',
    enqueue: 'Tambahkan ke antrean', placeholder: 'Tambahkan pesan lanjutan ke antrean…', attachments: '{count} lampiran',
    limit: 'Masukkan pesan berisi 1–{limit} karakter.',
  },
  de: {
    title: 'Nachrichten in der Warteschlange', count: '{count} in der Warteschlange', hint: 'Versand nach der aktuellen Aufgabe',
    paused: 'Warteschlange pausiert', resume: 'Warteschlange fortsetzen', edit: 'Nachricht bearbeiten', remove: 'Nachricht aus Warteschlange löschen',
    save: 'Speichern', cancel: 'Abbrechen', editLabel: 'Nachricht bearbeiten', submitting: 'Wird gesendet…',
    enqueue: 'Zur Warteschlange hinzufügen', placeholder: 'Weitere Nachricht zur Warteschlange hinzufügen…', attachments: '{count} Anhänge',
    limit: 'Nachricht mit 1–{limit} Zeichen eingeben.',
  },
  'pt-BR': {
    title: 'Mensagens na fila', count: '{count} na fila', hint: 'Enviadas após a tarefa atual',
    paused: 'Fila pausada', resume: 'Continuar fila', edit: 'Editar mensagem na fila', remove: 'Excluir mensagem da fila',
    save: 'Salvar', cancel: 'Cancelar', editLabel: 'Editar mensagem', submitting: 'Enviando…',
    enqueue: 'Adicionar à fila', placeholder: 'Adicionar uma mensagem à fila…', attachments: '{count} anexos',
    limit: 'Digite uma mensagem de 1 a {limit} caracteres.',
  },
  'es-ES': {
    title: 'Mensajes en cola', count: '{count} en cola', hint: 'Se envían después de la tarea actual',
    paused: 'Cola pausada', resume: 'Continuar cola', edit: 'Editar mensaje en cola', remove: 'Eliminar mensaje de la cola',
    save: 'Guardar', cancel: 'Cancelar', editLabel: 'Editar mensaje', submitting: 'Enviando…',
    enqueue: 'Añadir a la cola', placeholder: 'Añadir un mensaje a la cola…', attachments: '{count} archivos adjuntos',
    limit: 'Escribe un mensaje de 1 a {limit} caracteres.',
  },
  ru: {
    title: 'Очередь сообщений', count: 'В очереди: {count}', hint: 'Отправятся после текущей задачи',
    paused: 'Очередь приостановлена', resume: 'Продолжить очередь', edit: 'Изменить сообщение в очереди', remove: 'Удалить сообщение из очереди',
    save: 'Сохранить', cancel: 'Отмена', editLabel: 'Изменить сообщение', submitting: 'Отправка…',
    enqueue: 'Добавить в очередь', placeholder: 'Добавить следующее сообщение в очередь…', attachments: 'Вложений: {count}',
    limit: 'Введите сообщение длиной от 1 до {limit} символов.',
  },
  fa: {
    title: 'پیام‌های در صف', count: '{count} پیام در صف', hint: 'پس از کار فعلی ارسال می‌شوند',
    paused: 'صف متوقف شده', resume: 'ادامه صف', edit: 'ویرایش پیام در صف', remove: 'حذف پیام از صف',
    save: 'ذخیره', cancel: 'لغو', editLabel: 'ویرایش پیام', submitting: 'در حال ارسال…',
    enqueue: 'افزودن به صف', placeholder: 'پیام بعدی را به صف اضافه کنید…', attachments: '{count} پیوست',
    limit: 'پیامی با ۱ تا {limit} نویسه وارد کنید.',
  },
  ar: {
    title: 'الرسائل في قائمة الانتظار', count: '{count} في الانتظار', hint: 'تُرسل بعد المهمة الحالية',
    paused: 'قائمة الانتظار متوقفة مؤقتًا', resume: 'متابعة قائمة الانتظار', edit: 'تعديل الرسالة المنتظرة', remove: 'حذف الرسالة المنتظرة',
    save: 'حفظ', cancel: 'إلغاء', editLabel: 'تعديل الرسالة', submitting: 'جارٍ الإرسال…',
    enqueue: 'إضافة إلى قائمة الانتظار', placeholder: 'أضف رسالة متابعة إلى قائمة الانتظار…', attachments: '{count} مرفقات',
    limit: 'أدخل رسالة من 1 إلى {limit} حرفًا.',
  },
  ja: {
    title: '送信待ちメッセージ', count: '{count} 件待機中', hint: '現在のタスク完了後に順次送信',
    paused: 'キューは一時停止中', resume: 'キューを再開', edit: '送信待ちメッセージを編集', remove: '送信待ちメッセージを削除',
    save: '保存', cancel: 'キャンセル', editLabel: 'メッセージを編集', submitting: '送信中…',
    enqueue: 'キューに追加', placeholder: '続きのメッセージをキューに追加…', attachments: '添付ファイル {count} 件',
    limit: '1〜{limit} 文字のメッセージを入力してください。',
  },
  ko: {
    title: '대기 중인 메시지', count: '{count}개 대기 중', hint: '현재 작업이 끝나면 순서대로 전송',
    paused: '대기열 일시 중지됨', resume: '대기열 계속', edit: '대기 메시지 수정', remove: '대기 메시지 삭제',
    save: '저장', cancel: '취소', editLabel: '메시지 수정', submitting: '전송 중…',
    enqueue: '대기열에 추가', placeholder: '후속 메시지를 대기열에 추가…', attachments: '첨부 파일 {count}개',
    limit: '1~{limit}자의 메시지를 입력하세요.',
  },
  pl: {
    title: 'Wiadomości w kolejce', count: 'W kolejce: {count}', hint: 'Wysyłane po bieżącym zadaniu',
    paused: 'Kolejka wstrzymana', resume: 'Wznów kolejkę', edit: 'Edytuj wiadomość w kolejce', remove: 'Usuń wiadomość z kolejki',
    save: 'Zapisz', cancel: 'Anuluj', editLabel: 'Edytuj wiadomość', submitting: 'Wysyłanie…',
    enqueue: 'Dodaj do kolejki', placeholder: 'Dodaj kolejną wiadomość do kolejki…', attachments: 'Załączniki: {count}',
    limit: 'Wpisz wiadomość o długości 1–{limit} znaków.',
  },
  hu: {
    title: 'Sorban álló üzenetek', count: '{count} üzenet várakozik', hint: 'Az aktuális feladat után lesznek elküldve',
    paused: 'Várólista szüneteltetve', resume: 'Várólista folytatása', edit: 'Várakozó üzenet szerkesztése', remove: 'Várakozó üzenet törlése',
    save: 'Mentés', cancel: 'Mégse', editLabel: 'Üzenet szerkesztése', submitting: 'Küldés…',
    enqueue: 'Hozzáadás a várólistához', placeholder: 'Következő üzenet hozzáadása a várólistához…', attachments: '{count} melléklet',
    limit: 'Adjon meg egy 1–{limit} karakteres üzenetet.',
  },
  fr: {
    title: 'Messages en attente', count: '{count} en attente', hint: 'Envoyés après la tâche en cours',
    paused: 'File en pause', resume: 'Reprendre la file', edit: 'Modifier le message en attente', remove: 'Supprimer le message en attente',
    save: 'Enregistrer', cancel: 'Annuler', editLabel: 'Modifier le message', submitting: 'Envoi…',
    enqueue: 'Ajouter à la file', placeholder: 'Ajouter un message de suivi à la file…', attachments: '{count} pièces jointes',
    limit: 'Saisissez un message de 1 à {limit} caractères.',
  },
  uk: {
    title: 'Черга повідомлень', count: 'У черзі: {count}', hint: 'Надсилаються після поточного завдання',
    paused: 'Чергу призупинено', resume: 'Продовжити чергу', edit: 'Редагувати повідомлення в черзі', remove: 'Видалити повідомлення з черги',
    save: 'Зберегти', cancel: 'Скасувати', editLabel: 'Редагувати повідомлення', submitting: 'Надсилання…',
    enqueue: 'Додати до черги', placeholder: 'Додати наступне повідомлення до черги…', attachments: 'Вкладень: {count}',
    limit: 'Введіть повідомлення завдовжки від 1 до {limit} символів.',
  },
  tr: {
    title: 'Sıradaki mesajlar', count: '{count} mesaj sırada', hint: 'Geçerli görevden sonra gönderilir',
    paused: 'Kuyruk duraklatıldı', resume: 'Kuyruğa devam et', edit: 'Sıradaki mesajı düzenle', remove: 'Sıradaki mesajı sil',
    save: 'Kaydet', cancel: 'İptal', editLabel: 'Mesajı düzenle', submitting: 'Gönderiliyor…',
    enqueue: 'Kuyruğa ekle', placeholder: 'Kuyruğa bir takip mesajı ekle…', attachments: '{count} ek',
    limit: '1–{limit} karakter uzunluğunda bir mesaj girin.',
  },
  th: {
    title: 'ข้อความในคิว', count: '{count} ข้อความในคิว', hint: 'ส่งหลังจากงานปัจจุบันเสร็จสิ้น',
    paused: 'คิวหยุดชั่วคราว', resume: 'ดำเนินคิวต่อ', edit: 'แก้ไขข้อความในคิว', remove: 'ลบข้อความในคิว',
    save: 'บันทึก', cancel: 'ยกเลิก', editLabel: 'แก้ไขข้อความ', submitting: 'กำลังส่ง…',
    enqueue: 'เพิ่มลงในคิว', placeholder: 'เพิ่มข้อความถัดไปลงในคิว…', attachments: 'ไฟล์แนบ {count} รายการ',
    limit: 'ป้อนข้อความที่มีความยาว 1–{limit} อักขระ',
  },
  it: {
    title: 'Messaggi in coda', count: '{count} in coda', hint: 'Inviati dopo l’attività corrente',
    paused: 'Coda in pausa', resume: 'Riprendi coda', edit: 'Modifica messaggio in coda', remove: 'Elimina messaggio dalla coda',
    save: 'Salva', cancel: 'Annulla', editLabel: 'Modifica messaggio', submitting: 'Invio…',
    enqueue: 'Aggiungi alla coda', placeholder: 'Aggiungi un messaggio successivo alla coda…', attachments: '{count} allegati',
    limit: 'Inserisci un messaggio da 1 a {limit} caratteri.',
  },
};
