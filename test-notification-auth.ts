import axios from 'axios';

async function test() {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3MThhYzE0Mi1iOWI4LTRhNmEtOGMxMC05YTZmMTI4ZDM3NTAiLCJlbWFpbCI6ImFkbWluQGV4YW1wbGUuY29tIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzcyNjQzODgxfQ.BzvUc58bYARxVYgLnTcnsLUAM768unqvmHScbhu-LxA';
  try {
    const res = await axios.post('http://localhost:4000/notifications/send', {
      target: 'parents',
      title: 'Test Admin Notification',
      message: 'This should hit all parents in DB',
      type: 'info'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    console.log("Success:", res.data);
  } catch (error: any) {
    console.error("Error:", error.response?.data || error.message);
  }
}

test();
