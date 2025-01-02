require('dotenv').config();
const Koa = require('koa');//Koa 是一个轻量级的 Node.js 框架，用于构建 Web 应用程序
const Router = require('koa-router');//koa-router 是一个用于处理路由的 Koa 中间件
const bodyParser = require('koa-bodyparser');//koa-bodyparser 是一个用于解析请求体的 Koa 中间件
const cors = require('@koa/cors');//@koa/cors 是一个用于处理跨域请求的 Koa 中间件
const Stripe = require('stripe');//stripe 是一个用于处理 Stripe API 的库
const { createClient } = require('@supabase/supabase-js');//@supabase/supabase-js 是一个用于处理 Supabase 的库

const app = new Koa();//创建一个新的 Koa 应用
const router = new Router();//创建一个新的 Router 实例

// 添加 CORS 中间件
app.use(cors({
  origin: '*', // 允许所有来源，生产环境建议设置具体的域名
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
  exposeHeaders: ['WWW-Authenticate', 'Server-Authorization'],
  maxAge: 5,
  credentials: true,
}));

// 修改 bodyParser 配置
app.use(bodyParser({
  enableTypes: ['json', 'text'],
  extendTypes: {
    text: ['application/json'],
  },
  jsonLimit: '10mb',
  textLimit: '10mb',
  // 添加这个选项来保留原始请求体
  rawBody: true
}));

// 使用您的 Stripe 密钥
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 在现有的导入语句下面添加 Supabase 配置
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

// 注册路由
app.use(router.routes()).use(router.allowedMethods());

// 添加错误处理中间件
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('Server Error:', err);
    ctx.status = err.status || 500;
    ctx.body = {
      error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
    };
  }
});

router.get('/', async (ctx) => {
  ctx.body = {
    code:200,
    message:'success',
    data:{
      SUPABASE_URL:process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY:process.env.SUPABASE_ANON_KEY,
      STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET:process.env.STRIPE_WEBHOOK_SECRET
    }
  };
});

// 创建订阅产品和价格的 API
router.post('/create-subscription-products', async (ctx) => {
  try {
    // 创建一个阅读订阅产品
    const readingProduct = await stripe.products.create({
      name: 'niceNovel_Svip',
      description: '享受无限制阅读权限',
    });

    // 为同一产品创建多个价格选项
    const price3Days = await stripe.prices.create({
      product: readingProduct.id,
      unit_amount: 990, // $9.90
      currency: 'usd',
      recurring: {
        interval: 'day',
        interval_count: 3,
      },
      nickname: '3天订阅',
    });

    const price7Days = await stripe.prices.create({
      product: readingProduct.id,
      unit_amount: 1499, // $14.99
      currency: 'usd',
      recurring: {
        interval: 'day',
        interval_count: 7,
      },
      nickname: '7天订阅',
    });

    // 将价格信息保存到 Supabase
    const { data: savedPrices, error: dbError } = await supabase
      .from('stripe_prices')
      .insert([
        {
          price_id: price3Days.id,//price_id 是价格ID
          product_id: readingProduct.id,//product_id 是产品ID
          nickname: price3Days.nickname,//nickname 是价格昵称
          unit_amount: price3Days.unit_amount,//unit_amount 是价格单位金额
          currency: price3Days.currency,//currency 是价格货币
          interval: price3Days.recurring.interval,//interval 是价格间隔
          interval_count: price3Days.recurring.interval_count//interval_count 是价格间隔计数
        },
        {
          price_id: price7Days.id,
          product_id: readingProduct.id,
          nickname: price7Days.nickname,
          unit_amount: price7Days.unit_amount,
          currency: price7Days.currency,
          interval: price7Days.recurring.interval,
          interval_count: price7Days.recurring.interval_count
        }
      ]);

    if (dbError) {
      console.error('Error saving to database:', dbError);
      ctx.status = 500;
      ctx.body = {
        code: 500,
        message: 'Database error',
        error: dbError.message
      };
      return;
    }

    ctx.body = {
      code: 200,
      message: 'success',
      data: {
        product: readingProduct,
        prices: {
          threeDays: price3Days,
          sevenDays: price7Days,
        },
        savedPrices
      },
    };
  } catch (error) {
    console.error('Error creating subscription products:', error);
    ctx.status = 500;
    ctx.body = { 
      code: 500,
      message: error.message 
    };
  }
});

// 获取所有价格信息的 API
router.get('/subscription-prices', async (ctx) => {
  try {
    const { data: prices, error } = await supabase
      .from('stripe_prices')
      .select('*')
      .order('unit_amount', { ascending: true });

    if (error) {
      throw error;
    }

    ctx.body = {
      code: 200,
      message: 'success',
      data: prices
    };

  } catch (error) {
    console.error('Error fetching prices:', error);
    ctx.status = 500;
    ctx.body = {
      code: 500,
      message: error.message
    };
  }
});

// 创建订阅的 API
router.post('/create-subscription', async (ctx) => {
  try {
    const { priceId, email } = ctx.request.body;
    // 验证必需的参数
    if (!priceId || !email) {
      ctx.body = {
        code: 400,
        message: 'Missing required parameters: priceId or email',
        data:[]
      };
      return;
    }

    // 创建 Stripe 客户
    const customer = await stripe.customers.create({
      email: email,
    });

    // 修改这里的订阅创建代码
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price: priceId,
          quantity: 1  // 明确指定数量
        }
      ],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    ctx.body = {
      code: 200,
      message: 'success',
      data: {
        customerId: customer.id,//customerId 是客户ID
        subscriptionId: subscription.id,//subscriptionId 是订阅ID
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,//clientSecret 是客户端密钥
      }
    };
  } catch (error) {
    console.error('Error creating subscription:', error);
    ctx.body = {
      code:500,
      message:error.message,
      data:[]
    };
  }
});

// 处理 Stripe Webhook
router.post('/webhook', async (ctx) => {
  const sig = ctx.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      ctx.request.rawBody, // 原始的请求体，确保使用了中间件保留原始 body
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'payment_intent.succeeded') {//payment_intent.succeeded 是支付成功的 Webhook 事件类型
      const paymentIntent = event.data.object;
      // console.log('Payment succeeded:', paymentIntent);
      // 处理支付成功的逻辑

    }
    else if(event.type === 'customer.subscription.updated'){
      const subscription = event.data.object;
      console.log('Subscription updated:', subscription);
      // 处理订阅更新的逻辑

    }
    else if(event.type === 'customer.subscription.deleted'){
      const subscription = event.data.object;
      console.log('Subscription deleted event received:', subscription.id);
      
      try {
        // 先检查订阅是否存在
        const { data: existingSubscription, error: checkError } = await supabase
          .from('subscriptions')
          .select('*')
          .eq('stripe_subscription_id', subscription.id)
          .single();

        if (checkError) {
          console.error('Error checking subscription:', checkError);
          ctx.body = { 
            code:500,
            message: 'Error checking subscription',
            data:[]
          };
          return;
        }

        if (!existingSubscription) {
          console.log('Subscription not found in database:', subscription.id);
          ctx.body = {
            code:200,
            message: 'Subscription not found',
            data:[]
          };
          return;
        }

        // 执行删除操作
        const { error: deleteError } = await supabase
          .from('subscriptions')
          .delete()
          .eq('stripe_subscription_id', subscription.id);

        if (deleteError) {
            console.error('Error deleting subscription:', deleteError);
            ctx.body = {
              code:500,
              message: 'Error deleting subscription',
              data:[]
            };
            return;
        }

        console.log('Successfully deleted subscription:', subscription.id);
        ctx.body = { 
          code:200,
          message: 'Subscription deleted successfully',
          data:[]
        };
      } catch (error) {
        console.error('Unexpected error during subscription deletion:', error);
        ctx.body = {
          code:500,
          message: 'Internal server error',
          data:[]
        };
      }
    }
    else if(event.type === 'customer.subscription.created'){
      const subscription = event.data.object;
      // console.log('Subscription created:', subscription);
      // 处理订阅创建的逻辑

    }
    else if(event.type === 'customer.subscription.payment_method_updated'){
      const subscription = event.data.object;
      console.log('Subscription payment method updated:', subscription);
      // 处理订阅支付方法更新的逻辑
    }

    ctx.body = {
      code:200,
      message:'success',
      data:[]
    };
  } catch (err) {
    console.error('Webhook Error:', err.message);
    ctx.body = {
      code:400,
      message:err.message,
      data:[]
    };
  }
});

// 启动服务器
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

module.exports = app.callback()