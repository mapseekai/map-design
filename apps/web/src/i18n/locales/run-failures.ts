import type { Locale } from '../types';

export const runFailureCopy: Record<Locale, { failed: string; connection: string }> = {
  "en": { failed: "The run did not complete. Please try again.", connection: "The run connection ended unexpectedly. Please try again." },
  "id": { failed: "Proses tidak selesai. Silakan coba lagi.", connection: "Koneksi proses terputus secara tak terduga. Silakan coba lagi." },
  "de": { failed: "Der Lauf wurde nicht abgeschlossen. Bitte erneut versuchen.", connection: "Die Verbindung zum Lauf wurde unerwartet unterbrochen. Bitte erneut versuchen." },
  "zh-CN": { failed: "运行未能完成。请重试。", connection: "运行连接意外中断。请重试。" },
  "zh-TW": { failed: "執行未能完成。請重試。", connection: "執行連線意外中斷。請重試。" },
  "pt-BR": { failed: "A execução não foi concluída. Tente novamente.", connection: "A conexão da execução foi interrompida inesperadamente. Tente novamente." },
  "es-ES": { failed: "La ejecución no se completó. Inténtalo de nuevo.", connection: "La conexión de la ejecución se interrumpió inesperadamente. Inténtalo de nuevo." },
  "ru": { failed: "Выполнение не завершено. Повторите попытку.", connection: "Соединение неожиданно прервалось. Повторите попытку." },
  "fa": { failed: "اجرا کامل نشد. دوباره تلاش کنید.", connection: "اتصال اجرا به‌طور غیرمنتظره قطع شد. دوباره تلاش کنید." },
  "ar": { failed: "لم يكتمل التشغيل. حاول مرة أخرى.", connection: "انقطع اتصال التشغيل بشكل غير متوقع. حاول مرة أخرى." },
  "ja": { failed: "実行が完了しませんでした。もう一度お試しください。", connection: "実行中の接続が予期せず切断されました。もう一度お試しください。" },
  "ko": { failed: "실행이 완료되지 않았습니다. 다시 시도해 주세요.", connection: "실행 중 연결이 예기치 않게 끊겼습니다. 다시 시도해 주세요." },
  "pl": { failed: "Wykonanie nie zostało ukończone. Spróbuj ponownie.", connection: "Połączenie zostało nieoczekiwanie przerwane. Spróbuj ponownie." },
  "hu": { failed: "A futás nem fejeződött be. Próbálja újra.", connection: "A futás kapcsolata váratlanul megszakadt. Próbálja újra." },
  "fr": { failed: "L’exécution ne s’est pas terminée. Réessayez.", connection: "La connexion de l’exécution a été interrompue de manière inattendue. Réessayez." },
  "uk": { failed: "Виконання не завершено. Спробуйте ще раз.", connection: "З’єднання несподівано перервалося. Спробуйте ще раз." },
  "tr": { failed: "Çalıştırma tamamlanmadı. Lütfen tekrar deneyin.", connection: "Çalıştırma bağlantısı beklenmedik şekilde kesildi. Lütfen tekrar deneyin." },
  "th": { failed: "การทำงานไม่เสร็จสมบูรณ์ โปรดลองอีกครั้ง", connection: "การเชื่อมต่อระหว่างการทำงานขาดหายโดยไม่คาดคิด โปรดลองอีกครั้ง" },
  "it": { failed: "L’esecuzione non è stata completata. Riprova.", connection: "La connessione dell’esecuzione si è interrotta inaspettatamente. Riprova." },
};
