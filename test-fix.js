/**
 * 简单的测试脚本来验证 API 修复
 */

async function testChatAPI() {
  console.log("开始测试聊天 API...");
  
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Hello, this is a test message." }
        ],
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      }),
    });

    console.log("响应状态:", response.status);
    console.log("响应头:", Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error("API 错误:", errorText);
      return false;
    }

    // 测试流式响应
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let messageCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log("流结束");
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.substring(6);
          if (jsonStr.trim() === "") continue;
          
          try {
            const data = JSON.parse(jsonStr);
            if (data.response) {
              messageCount++;
              process.stdout.write(data.response);
            }
          } catch (e) {
            console.error("解析错误:", e);
          }
        }
      }
    }

    console.log(`\n\n测试完成！收到 ${messageCount} 个消息块`);
    return true;

  } catch (error) {
    console.error("测试失败:", error);
    return false;
  }
}

// 如果直接运行此脚本
if (typeof window === 'undefined') {
  console.log("请在浏览器中运行此测试");
} else {
  // 在浏览器中运行
  testChatAPI().then(success => {
    if (success) {
      console.log("✅ API 测试通过");
    } else {
      console.log("❌ API 测试失败");
    }
  });
} 