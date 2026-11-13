import { getTasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export default async function DbTestPage() {
  const tasks = await getTasks();

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">
        DynamoDB 測試頁面
      </h1>

      <p className="mt-4">
        目前有 {tasks.length} 筆任務
      </p>

      <pre className="mt-4 overflow-auto rounded bg-gray-100 p-4 text-black">
        {JSON.stringify(tasks, null, 2)}
      </pre>
    </main>
  );
}
