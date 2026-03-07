import axios from 'axios';

async function test() {
  try {
    const res = await axios.post('http://localhost:4000/notifications/send', {
      target: 'parents',
      title: 'Test Notification from Script',
      message: 'This is a test to see if it saves to DB',
      type: 'info'
    }, {
      headers: {
        'Content-Type': 'application/json'
        // Missing Authorization header intentionally to see if that's the issue
      }
    });
    console.log(res.data);
  } catch (error: any) {
    console.error(error.response?.data || error.message);
  }
}

test();
