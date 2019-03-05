const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { transport, makeANiceEmail } = require("../mail");
const { hasPermission } = require("../utils");
const stripe = require('../stripe');

const Mutations = {
  async createItem(parent, args, ctx, info) {
    //TODO: check to see if they are logged in
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }

    const item = await ctx.db.mutation.createItem(
      {
        data: {
          //create relationship between item and user
          user: {
            connect: {
              id: ctx.request.userId
            }
          },
          ...args
        }
      },
      info
    );

    return item;
  },
  updateItem(parent, args, ctx, info) {
    //first take a copy of the update
    const updates = { ...args };
    //remove the ID from the update
    delete updates.id;
    //run the update method
    return ctx.db.mutation.updateItem(
      {
        data: updates,
        where: {
          id: args.id
        }
      },
      info
    );
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };
    //1. find the item
    const item = await ctx.db.query.item({ where }, `{ id title user { id }}`);
    //2. check if they own that item or have permissions to delete
    const ownsItem = item.user.id === ctx.request.userId;
    const hasPermissions = ctx.request.user.permissions.some(permission =>
      ["ADMIN", "ITEMDELETE"].includes(permission)
    );

    if (!ownsItem && !hasPermissions) {
      throw new Error("You don't have permission to do that!");
    }

    //3. delete it
    return ctx.db.mutation.deleteItem({ where }, info);
  },
  async signup(parent, args, ctx, info) {
    //lowercase email
    args.email = args.email.toLowerCase();
    //hash password
    const password = await bcrypt.hash(args.password, 10);
    //create user in database
    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password,
          permissions: { set: ["USER"] }
        }
      },
      info
    );
    //create jwt for user
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    //set jwt as a cookie on response
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
    //return user to browser
    return user;
  },
  async signin(parent, { email, password }, ctx, info) {
    //1. check if there is a user with same email
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error("No such user found with email: ${email}");
    }
    //2. check if their password is correct
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error("Invalid Password!");
    }
    //3. generate jwt token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    //4. set the cookie with the token
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
    // 5. return user
    return user;
  },
  signout(parent, args, ctx, info) {
    ctx.response.clearCookie("token");
  },
  async requestReset(parent, args, ctx, info) {
    //1 check user
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error("No such user found with email: ${ args.email }");
    }
    //2 set reset token and expiry for user
    const randomBytesPromisified = promisify(randomBytes);
    const resetToken = (await randomBytesPromisified(20)).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; //1 hour
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry }
    });
    //3 email reset token
    const mailRes = await transport.sendMail({
      from: "lagrangepoint2@gmail.com",
      to: user.email,
      subject: "Your Password Reset Token",
      html: makeANiceEmail(
        `Your Password Reset Token is Here! \n\n <a href="${
          process.env.FRONTEND_URL
        }/reset?resetToken=${resetToken}">Click here to reset your password.</a>`
      )
    });
    //4 return the message
    return { message: "Thanks!" };
  },
  async resetPassword(parent, args, ctx, info) {
    //1 check matching passwords
    if (args.password !== args.confirmPassword) {
      throw new Error("Passwords do not match!");
    }
    //2 check reset token
    //3 check expiry
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000
      }
    });
    if (!user) {
      throw new Error("This token is either invalid or expired!");
    }
    //4 hash new password
    const password = await bcrypt.hash(args.password, 10);
    //5 save new password to the user and remove old resetToken fields
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    });
    //6 generate jwt
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    //7 set the jwt cookie
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
    //8 return new user
    return updatedUser;
  },
  async updatePermissions(parent, args, ctx, info) {
    //checked if they are logged in
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }
    //query current user
    const currentUser = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId
        }
      },
      info
    );
    //check permissions
    hasPermission(currentUser, ["ADMIN", "PERMISSIONUPDATE"]);
    //update permissions
    return ctx.db.mutation.updateUser(
      {
        data: {
          permissions: {
            set: args.permissions
          }
        },
        where: {
          id: args.userId
        }
      },
      info
    );
  },
  async addToCart(parent, args, ctx, info) {
    //1 make sure user is signed in
    const { userId } = ctx.request;
    if (!userId) {
      throw new Error("You must be signed in to add items to your cart!");
    }
    //2 query user current cart
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id }
      }
    });
    //3 check if item is already in cart and increment by 1
    if (existingCartItem) {
      console.log("Item is already in their cart");
      return ctx.db.mutation.updateCartItem(
        {
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + 1 }
        },
        info
      );
    }
    //4 if its not create a fresh cartItem
    return ctx.db.mutation.createCartItem(
      {
        data: {
          user: {
            connect: { id: userId }
          },
          item: {
            connect: { id: args.id }
          }
        }
      },
      info
    );
  },
  async removeFromCart(parent, args, ctx, info) {
    //find cart item
    const cartItem = await ctx.db.query.cartItem(
      {
        where: {
          id: args.id
        }
      },
      `{ id, user { id }}`
    );
    //make sure we found an item
    if (!cartItem) throw new Error("No Item Found!");
    //make sure they own that cart item
    if (cartItem.user.id !== ctx.request.userId) {
      throw new Error("You do not own that item!");
    }
    //delete cart item
    return ctx.db.mutation.deleteCartItem(
      {
        where: { id: args.id }
      },
      info
    );
  },
  async createOrder(parent, args, ctx, info) {
    // query current user and check sign in
    const { userId } = ctx.request;
    if (!userId)
      throw new Error("You must be signed in to complete your order!");
    const user = await ctx.db.query.user(
      { where: { id: userId } },
      `{
          id 
          name 
          email 
          cart { 
            id 
            quantity 
            item { title price id description image largeImage}
          }}`
    );
    // recalculate the total for the price
    const amount = user.cart.reduce(
      (tally, cartItem) => tally + cartItem.item.price * cartItem.quantity, 0
      );
      console.log(`Charging for ${amount}`);
    // create stripe charge (turn token into money)
      const charge = await stripe.charges.create({
        amount,
        currency: 'USD',
        source: args.token
      });
    // convert CartItems to OrderItems
    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        ...cartItem.item,
        quantity: cartItem.quantity,
        user: { connect: { id: userId } },
      };
      delete orderItem.id;
      return orderItem;
    });
    // create Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: { connect: { id: userId } }
      }
    });
    // clear user's cart, delete cartItems
    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({ where: {
      id_in: cartItemIds
    }
   });
    // return the order to client
    return order;
  }
};

module.exports = Mutations;
